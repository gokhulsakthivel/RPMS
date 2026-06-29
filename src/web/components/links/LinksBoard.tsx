// `LinksBoard` — single-glance "board" view that mirrors the depot's
// physical link board: each position is a row, LP / ALP for that position
// sit side-by-side, color-coded by category (Blue = LP Mail, Green = LP
// Passenger, Yellow = ALP). Replaces the previous TodaysPlanPanel.
//
// The board pairs an LP link with its ALP mirror by matching `cycleLength`
// and the position kind/segment shape, so the two rotations line up by
// position number. Links without a mirror render as a single-role board.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import type {
  AssignmentDraftRow,
  AssignmentRow,
  CrewRow,
  LeaveRow,
  LinkPositionRow,
  LinkProjectionRow,
  LinkRow,
  TrainWithAssignment,
} from '../../../shared/schemas';
import {
  ApiError,
  assignmentDrafts as assignmentDraftsApi,
  assignments as assignmentsApi,
  assistantLocoPilots as alpApi,
  leaves as leavesApi,
  links as linksApi,
  locoPilots as lpApi,
  trains as trainsApi,
} from '../../lib/api';

import type { LinksPlanPrSlot, LinksPlanSlot } from '../../lib/linksPlan';
import { prSlotKey } from '../../lib/linksPlan';
import { formatIst, formatIstTime } from '../../lib/time';
import { describeApiError } from '../../lib/errors';
import { findOutwardPair } from '../../../domain/linkPairing';
import { hasSufficientRest } from '../../../domain/hasSufficientRest';
import { TrainType } from '../../../domain/types';
import { Banner } from '../feedback/Banner';
import { EmptyState } from '../feedback/EmptyState';
import { SkeletonRows } from '../feedback/SkeletonRows';
import { useToast } from '../feedback/Toast';
import { useLinksBoardPrefs } from '../../lib/linksBoardPrefs';

// Compact IST formatter for rail meta lines \u2014 "19/Jun 14:30".
// Full "19 Jun 2026, 14:30 IST" stays in the title tooltip.
const compactIstDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
});
const compactIstTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function formatIstCompact(d: Date): string {
  // en-GB renders "19 Jun" \u2014 swap the space for "/" so it reads "19/Jun".
  const date = compactIstDateFormatter.format(d).replace(' ', '/');
  return `${date} ${compactIstTimeFormatter.format(d)}`;
}

// ----- Drag-and-drop types -------------------------------------------------
// Slice 1: drag a crew chip from the Unassigned rail onto an empty LP/ALP
// cell on a link card or the unlinked-trains card. Drop stages a draft
// in the server-backed cart (`/api/assignment-drafts`); the operator
// reviews and commits the cart from the Assignments page.
//
// Slice 2: assigned pills are also draggable. They carry their `source`
// assignment so the handler can stage a move / swap / unassign draft
// for both the source and target rows.
//
// The board itself continues to render committed (live) assignments —
// drafts only become visible after the user clicks "+ Assign (N)" on
// the Assignments page.

type DragSource =
  | {
      kind: 'rail';
      /**
       * When the rail-source pill was rendered from a rotation
       * projection (not from the bucket on the right), this carries the
       * train + role it came from. handleDragEnd uses it to null the
       * source slot in the plan so the same crew can't visibly occupy
       * two slots at once after a move.
       */
      projectedFrom?: {
        trainId: string;
        trainNumber: string;
        role: 'lp' | 'alp';
      };
    }
  | {
      kind: 'assignment';
      /**
       * Live committed assignment id, or `null` when the pill represents
       * a staged-create draft (no live row yet). The rail-drop handler
       * distinguishes the two: `null` → cancel the draft via
       * `assignmentDrafts.remove`; non-null → stage a delete/update draft.
       */
      assignmentId: string | null;
      role: 'lp' | 'alp';
      trainId: string;
      trainNumber: string;
    };

type DragCrew = (
  | {
      kind: 'lp';
      crewId: string;
      crewName: string;
      lpCategory: 'MAIL_EXPRESS' | 'PASSENGER';
      // Drives slot compatibility: an LP may carry MAIL_EXPRESS in here
      // even when their `lpCategory` is PASSENGER (cross-grade upskilling).
      lpEligibleTypes: readonly TrainType[];
      // ISO-8601 UTC string of the crew's last sign-off, or null if never
      // signed off. Combined with the slot's `departureTime` and
      // `MIN_REST_HOURS` to gate drops via `hasSufficientRest`.
      lastSignOffTime: string | null;
    }
  | {
      kind: 'alp';
      crewId: string;
      crewName: string;
      alpEligibleTypes: readonly TrainType[];
      lastSignOffTime: string | null;
    }
) & { source: DragSource };

type DropSlot =
  | {
      kind: 'lp-slot';
      trainId: string;
      trainNumber: string;
      runDate: string;
      // The train's type (PASSENGER / MAIL_EXPRESS / MEMU / …). The drop
      // gate requires this to appear in the dragged LP's
      // `eligibleTrainTypes` — the strict per-train check that supersedes
      // the older `requiredCategory` fast-path.
      trainType: TrainType;
      // ISO-8601 UTC departure used by `hasSufficientRest` to decide if
      // the dragged crew has cleared their rest window for this train.
      departureTime: string;
      // The link's required LP category for this slot. Mail-Express LPs
      // cannot be dropped on Passenger slots and vice-versa (HLD §4.2).
      requiredCategory: 'MAIL_EXPRESS' | 'PASSENGER' | null;
      existingAssignmentId: string | null;
      /** Currently-assigned LP id, or null. Drives move-vs-swap. */
      currentCrewId: string | null;
      // Inside a link, the rotation projects an ALP for this position even
      // before a live assignment exists. Carrying it here lets an LP-first
      // drop on a Mail/Express slot create the row by pairing the dropped
      // LP with the projected ALP — otherwise the orchestrator rejects
      // with ALP_REQUIRED_BUT_MISSING.
      defaultAlpId?: string | null;
    }
  | {
      kind: 'alp-slot';
      trainId: string;
      trainNumber: string;
      runDate: string;
      trainType: TrainType;
      departureTime: string;
      existingAssignmentId: string | null;
      // Inside a link, the rotation projects an LP for this slot even before
      // a live assignment exists. Carrying it here lets an ALP-first drop
      // create the row by pairing the dragged ALP with the projected LP.
      defaultLpId?: string | null;
      /** Currently-assigned ALP id, or null. Drives move-vs-swap. */
      currentCrewId: string | null;
    }
  | {
      // PR (Periodic Rest) row override target. PR rows have no train,
      // so there is no rest / type gate — any LP can be marked on PR
      // here. The override lives in the browser-local plan keyed by
      // (linkId, positionNumber).
      kind: 'pr-lp-slot';
      linkId: string;
      positionNumber: number;
      /** Currently-shown LP id (override or projection), or null. */
      currentCrewId: string | null;
    }
  | {
      kind: 'pr-alp-slot';
      linkId: string;
      positionNumber: number;
      currentCrewId: string | null;
    }
  | { kind: 'rail' };

function isCompatible(drag: DragCrew | undefined, slot: DropSlot): boolean {
  if (!drag) return false;
  if (slot.kind === 'rail') {
    // Assignment-sourced pills stage an unassign. Rotation-projected
    // pills (rail-sourced with a `projectedFrom`) stamp an explicit
    // null on the projected train so the projection stops filling it.
    // PR-row drags (rail-sourced without projectedFrom) fall through
    // as a silent no-op in the handler. All three are valid drops.
    return true;
  }
  if (slot.kind === 'pr-lp-slot' || slot.kind === 'pr-alp-slot') {
    // PR is operator-advised rest, not a duty assignment — no rest
    // window or train-type gate. Only the role and self-drop need to
    // match. Assignment-sourced drags are still allowed; the drop just
    // doesn't touch the live assignment, it only marks PR for today.
    if (slot.kind === 'pr-lp-slot' && drag.kind !== 'lp') return false;
    if (slot.kind === 'pr-alp-slot' && drag.kind !== 'alp') return false;
    if (slot.currentCrewId === drag.crewId) return false;
    return true;
  }
  // Shared gate for any slot drop: the crew must be rested enough to
  // sign on at this train's departure. Source of truth lives in the
  // pure domain helper so `MIN_REST_HOURS` stays in one place.
  const restOk = hasSufficientRest(
    { lastSignOffTime: drag.lastSignOffTime ? new Date(drag.lastSignOffTime) : undefined },
    new Date(slot.departureTime),
  );
  if (!restOk) return false;
  if (slot.kind === 'lp-slot' && drag.kind === 'lp') {
    if (slot.currentCrewId === drag.crewId) return false; // no-op
    // Strict per-train eligibility — a PASSENGER LP certified for
    // MAIL_EXPRESS can fill a MAIL_EXPRESS slot, and ditto for the
    // unlinked-trains card where any train type is possible.
    return drag.lpEligibleTypes.includes(slot.trainType);
  }
  if (slot.kind === 'alp-slot' && drag.kind === 'alp') {
    if (slot.currentCrewId === drag.crewId) return false;
    return drag.alpEligibleTypes.includes(slot.trainType);
  }
  return false;
}

export interface LinksBoardProps {
  date: string;
  links: ReadonlyArray<LinkRow>;
  refreshTick?: number;
  /** Browser-local override plan from `useLinksPlan(date)`. */
  plan: {
    runDate: string;
    slots: Record<string, LinksPlanSlot>;
    prSlots?: Record<string, LinksPlanPrSlot>;
    hiddenPrCrewIds?: string[];
  };
  /** Stage a slot patch. `null` for a role = explicitly empty. */
  setSlot: (trainId: string, patch: Partial<LinksPlanSlot>) => void;
  /** Drop the plan entry entirely (rotation default re-renders). */
  removeSlot: (trainId: string) => void;
  /** Pull a crew id off every slot it occupies, except an optional target. */
  vacateCrewFromPlan: (crewId: string, exceptTrainId?: string) => void;
  /** Dismiss a projected PR pill (per-date). */
  hidePrCrew: (crewId: string) => void;
  /** Patch a PR row override at `(linkId, positionNumber)`. */
  setPrSlot: (
    linkId: string,
    positionNumber: number,
    patch: Partial<LinksPlanPrSlot>,
  ) => void;
  /** Drop the PR row override entirely. */
  removePrSlot: (linkId: string, positionNumber: number) => void;
}

interface BoardPair {
  key: string;
  title: string;
  lp: LinkRow;
  alp?: LinkRow;
}

/** Combined remote data the board needs. */
interface BoardData {
  /** Run date this snapshot was fetched for; used to guard the optimistic-keep behaviour during re-fetches. */
  runDate: string;
  projection: LinkProjectionRow[];
  assignments: AssignmentRow[];
  prevDayAssignments: AssignmentRow[];
  lps: CrewRow[];
  alps: CrewRow[];
  trains: TrainWithAssignment[];
  /**
   * Staged drafts for this run date. Merged on top of `assignments` so
   * the board reflects DnD changes immediately (before the operator
   * commits the cart on the Assignments page).
   */
  drafts: AssignmentDraftRow[];
  /** All non-archived leaves; filtered client-side to the run date. */
  leaves: LeaveRow[];
}

export function LinksBoard({
  date,
  links,
  refreshTick = 0,
  plan,
  setSlot,
  removeSlot,
  vacateCrewFromPlan,
  hidePrCrew,
  setPrSlot,
  removePrSlot,
}: LinksBoardProps) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `pendingTrainIds` stays for a future async-validation pass but is
  // always empty under the local-plan flow — DnD is synchronous now.
  const [pendingTrainIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [activeDrag, setActiveDrag] = useState<DragCrew | null>(null);
  const toast = useToast();

  // Rotation-defaults feature is disabled: the rotation projection is
  // never used to pre-fill slots or take crew off the rail. Operator
  // assigns purely by drag-and-drop. Constant kept so dependent memos
  // remain typed; their `if (applyRotationDefaults)` branches are dead.
  const applyRotationDefaults = false;

  // Right-side crew rail can be collapsed to a thin strip so the board
  // gets near-full horizontal space when the operator is planning
  // rotations rather than assigning crew. Persisted across reloads.
  const { crewRailCollapsed, setCrewRailCollapsed } = useLinksBoardPrefs();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Trains the operator has explicitly touched via DnD. The renderer
  // must NOT fall back to the rotation projection for these — an
  // emptied slot in the plan means "intentional empty", not "please
  // re-show the rotation default". Without this, moving a crew off a
  // rotation-seeded slot leaves the rotation pill behind, making the
  // crew appear in two places at once.
  const planOverriddenTrainIds = useMemo<ReadonlySet<string>>(
    () => new Set(Object.keys(plan.slots)),
    [plan.slots],
  );
  // Per-date dismissed PR pills. Wrapped in a Set so the BoardCard's
  // PR-row filter is O(1) per row.
  const hiddenPrCrewIds = useMemo<ReadonlySet<string>>(
    () => new Set(plan.hiddenPrCrewIds ?? []),
    [plan.hiddenPrCrewIds],
  );
  // PR row overrides keyed by `${linkId}:p${positionNumber}`. The
  // BoardCard reads this map to render the operator's chosen crew on
  // a PR row in place of the rotation projection.
  const prSlotByKey = useMemo<ReadonlyMap<string, LinksPlanPrSlot>>(
    () => new Map(Object.entries(plan.prSlots ?? {})),
    [plan.prSlots],
  );
  // Set of crew ids currently sitting in any PR override. The rail
  // bucket excludes these so the crew can't be on PR and in the rail
  // at the same time.
  const prTakenCrewIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const v of prSlotByKey.values()) {
      if (v.lpId) s.add(v.lpId);
      if (v.alpId) s.add(v.alpId);
    }
    return s;
  }, [prSlotByKey]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Only clear data on a true date change, NOT on a reloadTick bump.
    // Re-fetches triggered by DnD must keep the existing pills on screen
    // until the new data lands; otherwise the board blanks for ~1 frame
    // and the user perceives the drop as "didn't happen".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setData((prev) => (prev && prev.runDate === date ? prev : null));
    const prevDate = previousIsoDate(date);
    Promise.all([
      linksApi.projection(date),
      assignmentsApi.list(date),
      assignmentsApi.list(prevDate).catch(() => [] as AssignmentRow[]),
      lpApi.list(date),
      alpApi.list(date),
      trainsApi.list(date),
      assignmentDraftsApi.list(date).catch(() => [] as AssignmentDraftRow[]),
      leavesApi.list().catch(() => [] as LeaveRow[]),
    ])
      .then(([projection, assignments, prevDayAssignments, lps, alps, trains, drafts, leaves]) => {
        if (cancelled) return;
        setData({ runDate: date, projection, assignments, prevDayAssignments, lps, alps, trains, drafts, leaves });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [date, refreshTick]);

  const pairs = useMemo(() => pairLinks(links), [links]);
  const lookup = useMemo(
    () => buildLookup(data?.projection ?? []),
    [data],
  );

  // trainId → rotation-projected {lpId, alpId} for this run date. Built
  // by walking pairs × DUTY positions × segments and resolving each
  // segment's train number against the projection lookup. Used by
  // patchSlot (so a partial null preserves the un-touched role) and by
  // the rail's `taken` set (so removing a role frees that crew back to
  // the bucket).
  const rotationByTrainId = useMemo(() => {
    const m = new Map<string, { lpId: string | null; alpId: string | null }>();
    if (!data) return m;
    const trainIdLookup = new Map<string, string>();
    for (const t of data.trains) {
      if (t.number) trainIdLookup.set(t.number, t.id);
    }
    for (const t of data.trains) {
      if (t.inwardTrainNumber && !trainIdLookup.has(t.inwardTrainNumber)) {
        trainIdLookup.set(t.inwardTrainNumber, t.id);
      }
    }
    for (const pair of pairs) {
      const lpByPos = lookup.get(pair.lp.id);
      const alpByPos = pair.alp ? lookup.get(pair.alp.id) : undefined;
      for (const pos of pair.lp.positions) {
        if (pos.kind !== 'DUTY') continue;
        const lpId = lpByPos?.get(pos.positionNumber)?.[0]?.crewId ?? null;
        const alpId = alpByPos?.get(pos.positionNumber)?.[0]?.crewId ?? null;
        for (const seg of pos.segments) {
          const trainId = trainIdLookup.get(seg.trainNumber);
          if (!trainId) continue;
          // First wins — matches how the renderer picks projectedLp/Alp.
          if (!m.has(trainId)) m.set(trainId, { lpId, alpId });
        }
      }
    }
    return m;
  }, [data, pairs, lookup]);
  // Apply staged drafts on top of the committed assignments. The board
  // renders this merged view so DnD changes are visible immediately,
  // before the operator commits the cart from the Assignments page.
  //   create  \u2192 inserts a synthetic AssignmentRow (assignmentId = null)
  //   update  \u2192 overrides crew on the matching live row
  //   delete  \u2192 removes the live row from the merged set
  const mergedAssignments = useMemo<AssignmentRow[]>(() => {
    if (!data) return [];
    const byTrainId = new Map<string, AssignmentRow>();
    for (const a of data.assignments) byTrainId.set(a.trainId, a);
    for (const d of data.drafts) {
      if (d.kind === 'delete') {
        byTrainId.delete(d.trainId);
        continue;
      }
      const lp = { id: d.lpId, name: d.lpName };
      const alp: AssignmentRow['alp'] = d.alpId
        ? { id: d.alpId, name: d.alpName ?? '' }
        : null;
      const alp2: AssignmentRow['alp2'] = d.alpId2
        ? { id: d.alpId2, name: d.alpName2 ?? '' }
        : null;
      if (d.kind === 'create') {
        byTrainId.set(d.trainId, {
          trainId: d.trainId,
          trainNumber: d.trainNumber,
          trainName: d.trainName,
          trainType: d.trainType,
          runDate: d.runDate,
          departureTime: d.departureTime,
          lp,
          alp,
          alp2,
          isAssignable: true,
          assignmentId: null,
        });
      } else {
        const base = byTrainId.get(d.trainId);
        if (base) {
          byTrainId.set(d.trainId, { ...base, lp, alp, alp2 });
        } else {
          byTrainId.set(d.trainId, {
            trainId: d.trainId,
            trainNumber: d.trainNumber,
            trainName: d.trainName,
            trainType: d.trainType,
            runDate: d.runDate,
            departureTime: d.departureTime,
            lp,
            alp,
            alp2,
            isAssignable: true,
            assignmentId: d.assignmentId,
          });
        }
      }
    }
    return Array.from(byTrainId.values());
  }, [data]);

  // Names by id for the plan-overlay step. (Built early; used both here
  // and by drag pills further down.) The full lookup is computed below
  // again with extra fallbacks for foreign / archived crew; we duplicate
  // a minimal name resolver here so the plan-overlay useMemo doesn't
  // depend on the larger one and cause a re-render cascade.
  const planLpName = useMemo(() => {
    const m = new Map<string, string>();
    for (const lp of data?.lps ?? []) m.set(lp.id, lp.name);
    return m;
  }, [data]);
  const planAlpName = useMemo(() => {
    const m = new Map<string, string>();
    for (const alp of data?.alps ?? []) m.set(alp.id, alp.name);
    return m;
  }, [data]);

  // Overlay the browser-local plan on top of the merged view. The plan
  // is the operator's pending edit, never sent to the server until they
  // click "Auto-Draft from links". Priority: plan > server-draft > live
  // > rotation default.
  const mergedWithPlan = useMemo<AssignmentRow[]>(() => {
    if (!data) return [];
    if (!plan || Object.keys(plan.slots).length === 0) return mergedAssignments;
    const byTrainId = new Map<string, AssignmentRow>();
    for (const a of mergedAssignments) byTrainId.set(a.trainId, a);
    const trainMeta = new Map<string, TrainWithAssignment>();
    for (const t of data.trains) trainMeta.set(t.id, t);
    for (const [trainId, slot] of Object.entries(plan.slots)) {
      const base = byTrainId.get(trainId);
      const t = trainMeta.get(trainId);
      const lp = slot.lpId
        ? { id: slot.lpId, name: planLpName.get(slot.lpId) ?? base?.lp?.name ?? '' }
        : null;
      const alp: AssignmentRow['alp'] = slot.alpId
        ? { id: slot.alpId, name: planAlpName.get(slot.alpId) ?? '' }
        : base && base.alp === 'NOT_REQUIRED'
          ? 'NOT_REQUIRED'
          : null;
      const alp2: AssignmentRow['alp2'] = slot.alpId2
        ? { id: slot.alpId2, name: planAlpName.get(slot.alpId2) ?? '' }
        : base && base.alp2 === 'NOT_REQUIRED'
          ? 'NOT_REQUIRED'
          : null;
      // Fully-empty plan slot on a row with no live assignment \u2192 drop
      // the merged row so the slot renders as empty (rotation default
      // is *not* re-applied; that's the "intentional empty" semantics).
      if (!lp && !slot.alpId && !slot.alpId2 && (!base || base.assignmentId === null)) {
        byTrainId.delete(trainId);
        continue;
      }
      if (base) {
        byTrainId.set(trainId, { ...base, lp, alp, alp2 });
      } else if (t) {
        byTrainId.set(trainId, {
          trainId: t.id,
          trainNumber: t.number,
          trainName: t.name,
          trainType: t.type,
          runDate: date,
          departureTime: t.departureTime,
          lp,
          alp,
          alp2,
          isAssignable: true,
          assignmentId: null,
        });
      }
    }
    return Array.from(byTrainId.values());
  }, [data, mergedAssignments, plan, planLpName, planAlpName, date]);
  // trainNumber \u2192 active assignment (merged with drafts) for this run date.
  const assignmentByTrain = useMemo(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of mergedWithPlan) m.set(a.trainNumber, a);
    return m;
  }, [mergedWithPlan]);
  // Every crew id sitting in a duty assignment today (LP, ALP, ALP2).
  // A crew on duty cannot also be resting on a PR row — the PR-row
  // renderer uses this to hide the projected pill once the operator
  // drops that crew onto a slot, so the source pill visibly disappears.
  const assignedCrewIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const a of mergedWithPlan) {
      if (a.lp) s.add(a.lp.id);
      if (a.alp && a.alp !== 'NOT_REQUIRED') s.add(a.alp.id);
      if (a.alp2 && a.alp2 !== 'NOT_REQUIRED') s.add(a.alp2.id);
    }
    return s;
  }, [mergedWithPlan]);
  // trainId \u2192 active assignment (merged). Drag sources carry trainId, not
  // number, so the draft builder reaches the source row through this map.
  const assignmentByTrainId = useMemo(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of mergedWithPlan) m.set(a.trainId, a);
    return m;
  }, [mergedWithPlan]);
  // trainId → train metadata (number, name, type, departureTime). Needed
  // when the target row has no existing assignment yet — the create draft
  // still has to carry display fields so the Assignments page can render
  // the cart without re-fetching.
  const trainById = useMemo(() => {
    const m = new Map<string, TrainWithAssignment>();
    for (const t of data?.trains ?? []) m.set(t.id, t);
    return m;
  }, [data]);
  // trainNumber → active assignment for the PREVIOUS run date. Powers the
  // inward→outward chain: an inward leg today inherits the crew assigned
  // to the paired outward leg from yesterday.
  const prevDayAssignmentByTrain = useMemo(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of data?.prevDayAssignments ?? []) m.set(a.trainNumber, a);
    return m;
  }, [data]);
  // LP id → designation, so an assignment's crew still gets the right color.
  const lpCategoryById = useMemo(() => {
    const m = new Map<string, 'MAIL_EXPRESS' | 'PASSENGER'>();
    for (const lp of data?.lps ?? []) {
      const cat = lp.editable.category;
      if (cat === 'MAIL_EXPRESS' || cat === 'PASSENGER') m.set(lp.id, cat);
    }
    return m;
  }, [data]);
  // LP id → eligibleTrainTypes. Threaded into every LP DragCrew so the
  // drop-compatibility check uses the strict eligibility list, not just
  // the LP's nominal category.
  const lpEligibleById = useMemo(() => {
    const m = new Map<string, readonly TrainType[]>();
    for (const lp of data?.lps ?? []) {
      m.set(lp.id, lp.editable.eligibleTrainTypes);
    }
    return m;
  }, [data]);

  // ALP id → eligibleTrainTypes. Mirror of lpEligibleById for ALPs.
  // Note: ALP eligibleTrainTypes can never include MEMU/DEMU (schema
  // invariant), which is why ALP-required slots only appear for trains
  // the ALP can actually be assigned to.
  const alpEligibleById = useMemo(() => {
    const m = new Map<string, readonly TrainType[]>();
    for (const alp of data?.alps ?? []) {
      m.set(alp.id, alp.editable.eligibleTrainTypes);
    }
    return m;
  }, [data]);
  // Crew id → last-sign-off ISO string. Drives the rest gate inside
  // `isCompatible`: any drop on a train slot is rejected when the crew
  // hasn't cleared MIN_REST_HOURS by the train's departure time.
  const lpSignOffById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const lp of data?.lps ?? []) {
      m.set(lp.id, lp.editable.lastSignOffTime);
    }
    return m;
  }, [data]);
  const alpSignOffById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const alp of data?.alps ?? []) {
      m.set(alp.id, alp.editable.lastSignOffTime);
    }
    return m;
  }, [data]);
  // Crew id → display name. Needed when staging a draft because the wire
  // format carries `lpName` / `alpName` snapshots so the Assignments page
  // can render the cart without re-fetching crew rows.
  //
  // The active crew lists from `/api/loco-pilots` exclude archived AND
  // foreign crew, but the link projection (and any live assignment) may
  // still reference them. Merge names from all three sources so dragging
  // a projected foreign-LP pill can still produce a valid draft.
  const lpNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const lp of data?.lps ?? []) m.set(lp.id, lp.name);
    for (const p of data?.projection ?? []) {
      if (p.crewRole === 'LP' && !m.has(p.crewId)) m.set(p.crewId, p.crewName);
    }
    for (const a of data?.assignments ?? []) {
      if (a.lp && !m.has(a.lp.id)) m.set(a.lp.id, a.lp.name);
    }
    for (const a of data?.prevDayAssignments ?? []) {
      if (a.lp && !m.has(a.lp.id)) m.set(a.lp.id, a.lp.name);
    }
    return m;
  }, [data]);
  const alpNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const alp of data?.alps ?? []) m.set(alp.id, alp.name);
    for (const p of data?.projection ?? []) {
      if (p.crewRole === 'ALP' && !m.has(p.crewId)) m.set(p.crewId, p.crewName);
    }
    for (const a of data?.assignments ?? []) {
      if (a.alp && a.alp !== 'NOT_REQUIRED' && !m.has(a.alp.id)) {
        m.set(a.alp.id, a.alp.name);
      }
      if (a.alp2 && a.alp2 !== 'NOT_REQUIRED' && !m.has(a.alp2.id)) {
        m.set(a.alp2.id, a.alp2.name);
      }
    }
    for (const a of data?.prevDayAssignments ?? []) {
      if (a.alp && a.alp !== 'NOT_REQUIRED' && !m.has(a.alp.id)) {
        m.set(a.alp.id, a.alp.name);
      }
    }
    return m;
  }, [data]);
  // trainNumber → destination station. A `TrainWithAssignment` carries
  // both an onward and an inward leg, so the same row contributes two
  // entries (e.g. `12671` → onwardToStation, `12672` → inwardToStation).
  //
  // Two rows can share a number: train A's primary number can equal
  // train B's `inwardTrainNumber` (e.g. `13351` is the primary for
  // Dhanbad-Alappuzha Express AND the return leg of Alappuzha-Dhanbad
  // Express). The depot LP always signs on for the **onward** leg, so
  // primaries take precedence — inwards only fill numbers that aren't
  // already mapped.
  const toStationByTrain = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.trains ?? []) {
      if (t.number) m.set(t.number, t.onwardToStation);
    }
    for (const t of data?.trains ?? []) {
      if (t.inwardTrainNumber && !m.has(t.inwardTrainNumber)) {
        m.set(t.inwardTrainNumber, t.inwardToStation);
      }
    }
    return m;
  }, [data]);

  // Right rail: crew NOT currently sitting in the board table,
  // partitioned into Eligible vs Ineligible.
  //   Ineligible = has an active SICK / LEAVE / TRAINING window covering
  //                `date`, OR `lastSignOffTime` is later than the last
  //                train departure on the run date (they haven't returned
  //                in time for any train today). PR (Periodic Rest) is
  //                advisory only — the operator can still assign PR
  //                crew, so they stay Eligible.
  //   Eligible   = everyone else who isn't already on the table.
  // Crew sitting in any merged-with-plan assignment or on any link
  // position (DUTY / PR / OFF) are excluded from the rail entirely —
  // they're "in use".
  const railBuckets = useMemo(() => {
    if (!data) return null;
    const taken = new Set<string>();
    for (const a of mergedWithPlan) {
      if (a.lp) taken.add(a.lp.id);
      if (a.alp && a.alp !== 'NOT_REQUIRED') taken.add(a.alp.id);
      if (a.alp2 && a.alp2 !== 'NOT_REQUIRED') taken.add(a.alp2.id);
    }
    // PR row overrides also remove crew from the rail \u2014 they're
    // "on PR" for the day per the operator's manual mark.
    for (const id of prTakenCrewIds) taken.add(id);
    // Add rotation projections, but ONLY for trains the operator hasn't
    // overridden in the plan. If a train has a plan entry, mergedWithPlan
    // is the source of truth for that train — adding its projection back
    // here would re-take a crew the operator just freed.
    //
    // Skipped entirely when `applyRotationDefaults` is off: the slots
    // render empty in that mode, so those crew must show up in the rail
    // for the operator to drag.
    if (applyRotationDefaults) {
      for (const [trainId, rot] of rotationByTrainId) {
        if (planOverriddenTrainIds.has(trainId)) continue;
        if (rot.lpId) taken.add(rot.lpId);
        if (rot.alpId) taken.add(rot.alpId);
      }
    }

    // Crew still mid-trip from yesterday's outward leg — they're on the
    // paired inward leg today and haven't signed off yet. Their persisted
    // `lastSignOffTime` reflects the trip BEFORE yesterday's sign-on, so
    // the rest gate below can't catch them. They must NOT be assignable,
    // but the operator still wants to see them on the rail (in the
    // Ineligible bucket) so it's clear who is currently out running an
    // inward leg. After tonight's sign-off stamps a new `lastSignOffTime`,
    // the rest gate takes over naturally.
    const onInwardLegToday = new Set<string>();
    for (const a of data.prevDayAssignments) {
      const t = trainById.get(a.trainId);
      if (!t?.inwardTrainNumber) continue; // pure one-way, already done yesterday
      if (a.lp) onInwardLegToday.add(a.lp.id);
      if (a.alp && a.alp !== 'NOT_REQUIRED') onInwardLegToday.add(a.alp.id);
      if (a.alp2 && a.alp2 !== 'NOT_REQUIRED') onInwardLegToday.add(a.alp2.id);
    }
    const onLeave = new Set<string>();
    for (const lv of data.leaves) {
      if (lv.type === 'PR') continue;
      if (lv.fromDate <= date && date <= lv.toDate) onLeave.add(lv.crewId);
    }
    // Crew whose rotation position today is PR (Periodic Rest) are
    // advisory-only — the operator may still assign them, mirroring the
    // existing skip for leave type === 'PR' above. Without this, a crew
    // who just signed off (and is therefore on PR today) would be sorted
    // into Ineligible purely on rest grounds.
    const onPrToday = new Set<string>();
    for (const row of data.projection) {
      if (row.position.kind === 'PR') onPrToday.add(row.crewId);
    }
    // Latest scheduled departure across all trains on the run date.
    // Retained for the meta tooltip / debugging only — actual rail
    // eligibility now runs through `eligibleForAnyTrainToday` below.
    // Crew who already have a committed assignment for today but currently
    // appear on the rail must have a staged unassign in flight. Their
    // persisted `lastSignOffTime` was stamped by that (about-to-be-removed)
    // assignment and is stale — skip the rest check for them so they don't
    // get sorted into Ineligible just because we're unstaging them.
    const stagedUnassignCrewIds = new Set<string>();
    for (const a of data.assignments) {
      if (a.lp) stagedUnassignCrewIds.add(a.lp.id);
      if (a.alp && a.alp !== 'NOT_REQUIRED') stagedUnassignCrewIds.add(a.alp.id);
      if (a.alp2 && a.alp2 !== 'NOT_REQUIRED') stagedUnassignCrewIds.add(a.alp2.id);
    }
    // Phase 5.3 rail-eligibility rule: a crew is Eligible only if there
    // is at least one train on the board today that they could actually
    // be assigned to, i.e. (a) the train's type is in their
    // `eligibleTrainTypes` and (b) they have sufficient rest
    // (`hasSufficientRest`, 16h gate in `MIN_REST_HOURS`) before that
    // train's departure. Staged-unassign crew skip the rest gate as
    // explained above.
    const eligibleForAnyTrainToday = (crew: CrewRow): boolean => {
      const types = crew.editable.eligibleTrainTypes;
      if (types.length === 0) return false;
      const skipRest = stagedUnassignCrewIds.has(crew.id);
      const signOff = crew.editable.lastSignOffTime
        ? new Date(crew.editable.lastSignOffTime)
        : undefined;
      for (const t of data.trains) {
        if (!t.departureTime) continue;
        if (!types.includes(t.type)) continue;
        if (skipRest) return true;
        if (hasSufficientRest({ lastSignOffTime: signOff }, new Date(t.departureTime))) {
          return true;
        }
      }
      return false;
    };
    const isIneligible = (crew: CrewRow): boolean => {
      if (onPrToday.has(crew.id)) return false;
      if (onLeave.has(crew.id)) return true;
      if (onInwardLegToday.has(crew.id)) return true;
      return !eligibleForAnyTrainToday(crew);
    };
    const eligible = {
      mailLp: [] as CrewRow[],
      passengerLp: [] as CrewRow[],
      alp: [] as CrewRow[],
    };
    const ineligible = {
      mailLp: [] as CrewRow[],
      passengerLp: [] as CrewRow[],
      alp: [] as CrewRow[],
    };
    for (const lp of data.lps) {
      if (taken.has(lp.id)) continue;
      const target = isIneligible(lp) ? ineligible : eligible;
      const cat = lp.editable.category;
      if (cat === 'MAIL_EXPRESS') target.mailLp.push(lp);
      else if (cat === 'PASSENGER') target.passengerLp.push(lp);
    }
    for (const a of data.alps) {
      if (taken.has(a.id)) continue;
      (isIneligible(a) ? ineligible : eligible).alp.push(a);
    }
    // Per-crew meta string for the rail card. Built here (not in the
    // bucket renderer) because the special-case labels (inward leg, PR,
    // leave) depend on sets that only this memo has assembled.
    const now = new Date();
    const buildMeta = (crew: CrewRow): { label: string; title: string } => {
      if (onInwardLegToday.has(crew.id)) {
        return {
          label: 'On inward leg today',
          title:
            "Currently mid-trip \u2014 hasn't signed off from yesterday's outward leg yet",
        };
      }
      if (onPrToday.has(crew.id)) {
        return {
          label: 'PR today',
          title: 'Periodic Rest today (per rotation) \u2014 still assignable',
        };
      }
      if (onLeave.has(crew.id)) {
        return { label: 'On leave', title: 'Leave covers today' };
      }
      const iso = crew.editable.lastSignOffTime;
      if (!iso) {
        return { label: 'No prior sign-off', title: 'No recorded sign-off' };
      }
      const d = new Date(iso);
      const ms = now.getTime() - d.getTime();
      const hours = Math.round(ms / 3_600_000);
      // Show a relative suffix only while sign-off is recent enough for
      // an hour count to be informative. Older sign-offs read as plain
      // "DD/Mon HH:mm" \u2014 the date itself already conveys age.
      let rel: string | null;
      if (ms < 0) rel = 'in future';
      else if (hours < 1) rel = '<1h ago';
      else if (hours < 48) rel = `${hours}h ago`;
      else rel = null;
      const full = formatIst(d);
      const short = formatIstCompact(d);
      return {
        label: rel ? `${short} \u00b7 ${rel}` : short,
        title: rel
          ? `Last sign-off: ${full} (${rel})`
          : `Last sign-off: ${full}`,
      };
    };
    const metaById = new Map<string, { label: string; title: string }>();
    for (const c of data.lps) metaById.set(c.id, buildMeta(c));
    for (const c of data.alps) metaById.set(c.id, buildMeta(c));
    return {
      eligible: {
        mailLp: sortByArrival(eligible.mailLp),
        passengerLp: sortByArrival(eligible.passengerLp),
        alp: sortByArrival(eligible.alp),
      },
      ineligible: {
        mailLp: sortByArrival(ineligible.mailLp),
        passengerLp: sortByArrival(ineligible.passengerLp),
        alp: sortByArrival(ineligible.alp),
      },
      metaById,
    };
  }, [data, mergedWithPlan, date, rotationByTrainId, planOverriddenTrainIds, applyRotationDefaults, trainById, prTakenCrewIds]);

  // Trains scheduled today whose onward NOR inward number appears on any
  // link's DUTY segment. These need manual assignment — they don't get a
  // board card.
  const uncoveredTrains = useMemo(() => {
    if (!data) return null;
    const covered = new Set<string>();
    for (const link of links) {
      for (const pos of link.positions) {
        if (pos.kind !== 'DUTY') continue;
        for (const seg of pos.segments) covered.add(seg.trainNumber);
      }
    }
    return data.trains
      .filter(
        (t) =>
          !covered.has(t.number) &&
          (!t.inwardTrainNumber || !covered.has(t.inwardTrainNumber)),
      )
      .slice()
      .sort((a, b) =>
        a.departureTime < b.departureTime ? -1 : a.departureTime > b.departureTime ? 1 : 0,
      );
  }, [data, links]);

  // trainNumber → trainId. Drag/drop needs the id (assignments orchestrator
  // keys on trainId, not number). Primary number wins on collision, matching
  // toStationByTrain's resolution order.
  const trainIdByNumber = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.trains ?? []) {
      if (t.number) m.set(t.number, t.id);
    }
    for (const t of data?.trains ?? []) {
      if (t.inwardTrainNumber && !m.has(t.inwardTrainNumber)) {
        m.set(t.inwardTrainNumber, t.id);
      }
    }
    return m;
  }, [data]);

  /**
   * onDragEnd — every drop stages a draft via `POST /api/assignment-drafts`
   * instead of committing live. The board still shows the persisted
   * (committed) state; the staged change appears in the Assignments page
   * cart and only takes effect when the operator clicks "+ Assign (N)".
   *
   * Slice 2 operations and the drafts they stage:
   *  - rail → empty slot         : create draft on target
   *  - rail → occupied slot      : update draft on target (new id on role)
   *  - pill → empty slot         : update/create draft on target + update/delete on source
   *  - pill → occupied slot      : update drafts on BOTH target and source (swap)
   *  - pill → rail               : update draft (ALP \u2192 null) or delete draft (LP) on source
   */
  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const drag = event.active.data.current as DragCrew | undefined;
    const slot = event.over?.data.current as DropSlot | undefined;
    if (!drag || !slot) return;
    if (!isCompatible(drag, slot)) {
      const msg =
        slot.kind === 'rail'
          ? `Drop on a crew row's slot to stage — or drag an assigned pill here to stage an unassign`
          : slot.kind === 'lp-slot' && drag.kind === 'lp'
            ? `${drag.crewName} is ${labelCategory(drag.lpCategory)} — can't drop on ${labelCategory(slot.requiredCategory)} slot`
            : `Wrong role for this slot`;
      toast.error(msg);
      return;
    }

    // The board's source of truth is now the browser-local plan. We
    // mutate that plan directly; the merged-with-plan render derives
    // automatically. Nothing leaves the browser until the operator
    // clicks "Auto-Draft from links" on the Links page toolbar.
    try {
      // ----- helpers -----------------------------------------------
      // Read the current effective slot for a train id, falling back
      // to the merged-without-plan view so dragging off a slot whose
      // crew is rotation/live-only correctly captures the displaced
      // crew id in a plan override.
      const readSlot = (trainId: string): { lpId: string | null; alpId: string | null; alpId2: string | null } => {
        const planned = plan.slots[trainId];
        if (planned) {
          return { lpId: planned.lpId, alpId: planned.alpId, alpId2: planned.alpId2 };
        }
        const a = assignmentByTrainId.get(trainId);
        // Rotation projection is only folded into the seed when the
        // rotation-defaults feature is enabled. With it disabled, an
        // untouched train has no implicit crew, so dropping AASISH on
        // ALP-2 must NOT drag the rotation's LP/ALP into the plan.
        const rot = applyRotationDefaults ? rotationByTrainId.get(trainId) : undefined;
        // Merge live + rotation so a partial patch (e.g. nulling LP)
        // doesn't accidentally drop a rotation-projected ALP. The live
        // assignment wins when it has a crew for that role; rotation
        // fills any role the live row leaves null.
        if (a || rot) {
          const liveAlpId =
            a?.alp && a.alp !== 'NOT_REQUIRED' ? a.alp.id : null;
          return {
            lpId: a?.lp?.id ?? rot?.lpId ?? null,
            alpId: liveAlpId ?? rot?.alpId ?? null,
            alpId2:
              a?.alp2 && a.alp2 !== 'NOT_REQUIRED' ? a.alp2.id : null,
          };
        }
        return { lpId: null, alpId: null, alpId2: null };
      };

      // Merge-aware setter. The first time a train is touched, seed the
      // plan slot from the current effective view (live + rotation) so a
      // partial patch like `{ alpId: null }` only nulls the ALP — the LP
      // projected by rotation stays put. Without this, the merge in
      // `withSlot` falls back to `emptySlot()` (all-null) and the patch
      // accidentally wipes every other role on the train.
      const patchSlot = (trainId: string, patch: Partial<LinksPlanSlot>) => {
        if (plan.slots[trainId]) {
          setSlot(trainId, patch);
          return;
        }
        const base = readSlot(trainId);
        setSlot(trainId, { ...base, ...patch });
      };

      // Look up where a rail-source pill currently sits in the crew
      // rail and toast it back. PR pills are advisory-only: the crew
      // is already in the rail, so the drag is a no-op — this just
      // tells the operator which bucket they're in (assigned / leave /
      // resting / eligible) instead of failing silently.
      const explainRailStanding = (d: DragCrew): void => {
        if (!data) return;
        const assignedTo = data.assignments.find((a) => {
          if (d.kind === 'lp') return a.lp?.id === d.crewId;
          const alp1 = a.alp && a.alp !== 'NOT_REQUIRED' ? a.alp.id : null;
          const alp2 = a.alp2 && a.alp2 !== 'NOT_REQUIRED' ? a.alp2.id : null;
          return alp1 === d.crewId || alp2 === d.crewId;
        });
        if (assignedTo) {
          toast.success(`${d.crewName} is already assigned to ${assignedTo.trainNumber} today`);
          return;
        }
        const leave = data.leaves.find(
          (lv) =>
            lv.crewId === d.crewId &&
            lv.type !== 'PR' &&
            lv.fromDate <= date &&
            date <= lv.toDate,
        );
        if (leave) {
          toast.success(`${d.crewName} is on ${leave.type} leave today`);
          return;
        }
        const row =
          d.kind === 'lp'
            ? data.lps.find((r) => r.id === d.crewId)
            : data.alps.find((r) => r.id === d.crewId);
        const signOff = row?.editable.lastSignOffTime;
        if (signOff) {
          toast.success(
            `${d.crewName} is in the crew rail (last sign-off ${formatIstTime(new Date(signOff))} IST)`,
          );
          return;
        }
        toast.success(`${d.crewName} is already in the crew rail`);
      };

      // ----- Case A: rail target (vacate the source slot) -----------
      if (slot.kind === 'rail') {
        if (drag.source.kind === 'rail') {
          // The pill came from a rotation projection (or the bucket).
          // If it had a source train tagged, null that slot so the
          // projection no longer fills it.
          const pf = drag.source.projectedFrom;
          if (pf) {
            if (pf.role === 'lp') {
              patchSlot(pf.trainId, { lpId: null });
            } else {
              const before = readSlot(pf.trainId);
              if (before.alpId2 === drag.crewId) {
                patchSlot(pf.trainId, { alpId2: null });
              } else {
                patchSlot(pf.trainId, { alpId: null });
              }
            }
            toast.success(`${drag.crewName} removed from ${pf.trainNumber}`);
            return;
          }
          // No projectedFrom — typically a PR-row pill. PR positions
          // are advisory rest, not a slot we can override. The crew is
          // already in the rail; the toast tells the operator where
          // they sit so the drag isn't a silent no-op. We deliberately
          // do NOT hide the pill from the PR row — keeping it visible
          // preserves the rotation's view of who is resting today.
          explainRailStanding(drag);
          return;
        }
        const source = drag.source;
        const before = readSlot(source.trainId);
        if (source.role === 'lp') {
          patchSlot(source.trainId, { lpId: null });
          toast.success(`${drag.crewName} removed from ${source.trainNumber}`);
        } else {
          // ALP: prefer the alpId match; alpId2 if it was the 2nd ALP.
          if (before.alpId === drag.crewId) {
            patchSlot(source.trainId, { alpId: null });
          } else if (before.alpId2 === drag.crewId) {
            patchSlot(source.trainId, { alpId2: null });
          } else {
            // Fallback: clear primary ALP.
            patchSlot(source.trainId, { alpId: null });
          }
          toast.success(`${drag.crewName} removed from ${source.trainNumber}`);
        }
        return;
      }

      // ----- Case A2: PR row target (per-link override, no train) ----
      // PR is operator-advised rest. We persist a per-(linkId, position,
      // role) override in the local plan; the cell re-renders to show
      // the dropped crew and the rail excludes them so the same crew
      // can't appear in two places.
      if (slot.kind === 'pr-lp-slot' || slot.kind === 'pr-alp-slot') {
        const role: 'lp' | 'alp' = slot.kind === 'pr-lp-slot' ? 'lp' : 'alp';
        // If the source was a rotation-projected DUTY pill, null the
        // source train's slot so the projection stops re-filling it.
        if (drag.source.kind === 'rail' && drag.source.projectedFrom) {
          const pf = drag.source.projectedFrom;
          if (pf.role === 'lp') {
            patchSlot(pf.trainId, { lpId: null });
          } else {
            const before = readSlot(pf.trainId);
            if (before.alpId2 === drag.crewId) {
              patchSlot(pf.trainId, { alpId2: null });
            } else {
              patchSlot(pf.trainId, { alpId: null });
            }
          }
        }
        const patch: Partial<LinksPlanPrSlot> =
          role === 'lp' ? { lpId: drag.crewId } : { alpId: drag.crewId };
        setPrSlot(slot.linkId, slot.positionNumber, patch);
        toast.success(`${drag.crewName} marked on PR`);
        return;
      }

      // ----- Case B1 / B2: target = slot ----------------------------
      const targetTrainId = slot.trainId;
      // Vacate the dragged crew from any other plan slot first, except
      // the destination (which is about to receive it). This is the
      // local-plan equivalent of the previous "stage move/swap source
      // update" branch — it keeps the crew unique across the plan.
      if (drag.source.kind === 'assignment' && drag.source.trainId !== targetTrainId) {
        vacateCrewFromPlan(drag.crewId, targetTrainId);
        // Also explicitly null the source role if it came from a live
        // row not yet in the plan, so the source slot really empties.
        const sourceLive = assignmentByTrainId.get(drag.source.trainId);
        if (sourceLive && !plan.slots[drag.source.trainId]) {
          if (drag.source.role === 'lp') {
            patchSlot(drag.source.trainId, { lpId: null });
          } else {
            const liveAlp =
              sourceLive.alp && sourceLive.alp !== 'NOT_REQUIRED' ? sourceLive.alp.id : null;
            if (liveAlp === drag.crewId) {
              patchSlot(drag.source.trainId, { alpId: null });
            } else {
              patchSlot(drag.source.trainId, { alpId2: null });
            }
          }
        }
      } else if (drag.source.kind === 'rail' && drag.source.projectedFrom) {
        // The pill came from a rotation-projection cell. The rotation
        // doesn't write the plan, so the source slot is invisible to
        // vacateCrewFromPlan — we have to explicitly null it here.
        const pf = drag.source.projectedFrom;
        if (pf.trainId !== targetTrainId) {
          if (pf.role === 'lp') {
            patchSlot(pf.trainId, { lpId: null });
          } else {
            const before = readSlot(pf.trainId);
            if (before.alpId2 === drag.crewId) {
              patchSlot(pf.trainId, { alpId2: null });
            } else {
              patchSlot(pf.trainId, { alpId: null });
            }
          }
        }
      }

      // Apply the target side.
      const targetBefore = readSlot(targetTrainId);
      // Resolve the source trainId for swap-park, supporting both
      // assignment-sourced and rotation-projected drags.
      const swapSourceTrainId =
        drag.source.kind === 'assignment'
          ? drag.source.trainId
          : drag.source.projectedFrom?.trainId ?? null;
      if (drag.kind === 'lp') {
        const displacedLpId = targetBefore.lpId;
        if (displacedLpId && swapSourceTrainId && swapSourceTrainId !== targetTrainId) {
          // Swap: park the displaced LP on the source train. Skip if
          // the source already has a plan entry (operator chose to
          // override it manually and we shouldn't second-guess).
          if (!plan.slots[swapSourceTrainId] || plan.slots[swapSourceTrainId]?.lpId === drag.crewId) {
            patchSlot(swapSourceTrainId, { lpId: displacedLpId });
          }
        }
        patchSlot(targetTrainId, { lpId: drag.crewId });
      } else {
        // ALP drop — figure out whether this is the primary or 2nd ALP
        // by looking at what's currently in the slot.
        const isSecondSlot =
          targetBefore.alpId !== null && targetBefore.alpId !== drag.crewId && targetBefore.alpId2 === null;
        const targetSlotField = isSecondSlot ? 'alpId2' : 'alpId';
        const displacedAlpId = isSecondSlot ? targetBefore.alpId2 : targetBefore.alpId;
        if (displacedAlpId && swapSourceTrainId && swapSourceTrainId !== targetTrainId) {
          if (!plan.slots[swapSourceTrainId] || plan.slots[swapSourceTrainId]?.alpId === drag.crewId) {
            patchSlot(swapSourceTrainId, { alpId: displacedAlpId });
          }
        }
        patchSlot(targetTrainId, { [targetSlotField]: drag.crewId } as Partial<LinksPlanSlot>);
      }

      toast.success(`${drag.crewName} → ${slot.trainNumber}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[LinksBoard] handleDragEnd threw', { drag, slot, error: e });
      toast.error(`Couldn't move ${drag.crewName} — ${(e as Error).message}`);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag((event.active.data.current as DragCrew | undefined) ?? null);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <section className="links-board" aria-label="Links board">
      <header className="links-board__header">
        <h2 className="links-board__title">Board · {date}</h2>
        <div className="links-board__header-controls">
          <Legend />
        </div>
      </header>

      {error ? (
        <Banner tone="error" title="Couldn't load board">
          {error}
        </Banner>
      ) : null}

      {data === null && !error ? <SkeletonRows rows={6} columns={4} /> : null}

      {data && pairs.length === 0 ? (
        <EmptyState
          icon="🔗"
          title="No links to show"
          description="Add a link in the Manage panel and anchor crew to it."
        />
      ) : null}

      {data ? (
        <div
          className={
            'links-board__body' +
            (crewRailCollapsed ? ' links-board__body--rail-collapsed' : '')
          }
        >
          <div className="links-board__main">
            <div className="links-board__grid">
              {pairs.map((p) => (
                <BoardCard
                  key={p.key}
                  pair={p}
                  lookup={lookup}
                  assignmentByTrain={assignmentByTrain}
                  prevDayAssignmentByTrain={prevDayAssignmentByTrain}
                  lpCategoryById={lpCategoryById}
                  lpEligibleById={lpEligibleById}
                  alpEligibleById={alpEligibleById}
                  lpSignOffById={lpSignOffById}
                  alpSignOffById={alpSignOffById}
                  lpNameById={lpNameById}
                  alpNameById={alpNameById}
                  trainById={trainById}
                  toStationByTrain={toStationByTrain}
                  trainIdByNumber={trainIdByNumber}
                  runDate={date}
                  pendingTrainIds={pendingTrainIds}
                  planOverriddenTrainIds={planOverriddenTrainIds}
                  assignedCrewIds={assignedCrewIds}
                  applyRotationDefaults={applyRotationDefaults}
                  hiddenPrCrewIds={hiddenPrCrewIds}
                  hidePrCrew={hidePrCrew}
                  prSlotByKey={prSlotByKey}
                  setPrSlot={setPrSlot}
                  removePrSlot={removePrSlot}
                />
              ))}
            </div>
            {uncoveredTrains && uncoveredTrains.length > 0 ? (
              <UnlinkedTrains
                trains={uncoveredTrains}
                assignmentByTrain={assignmentByTrain}
                toStationByTrain={toStationByTrain}
                lpCategoryById={lpCategoryById}
                lpEligibleById={lpEligibleById}
                alpEligibleById={alpEligibleById}
                lpSignOffById={lpSignOffById}
                alpSignOffById={alpSignOffById}
                runDate={date}
                pendingTrainIds={pendingTrainIds}
              />
            ) : null}
          </div>
          {railBuckets ? (
            <CrewRail
              buckets={railBuckets}
              metaById={railBuckets.metaById}
              collapsed={crewRailCollapsed}
              onToggleCollapsed={() => setCrewRailCollapsed(!crewRailCollapsed)}
            />
          ) : null}
        </div>
      ) : null}
    </section>
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <span
            className={`lb-pill lb-pill--${dragPillTone(activeDrag)} links-board__drag-ghost`}
          >
            {activeDrag.crewName}
          </span>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function dragPillTone(drag: DragCrew): 'mail' | 'passenger' | 'alp' {
  if (drag.kind === 'alp') return 'alp';
  return drag.lpCategory === 'PASSENGER' ? 'passenger' : 'mail';
}

function labelCategory(c: 'MAIL_EXPRESS' | 'PASSENGER' | null): string {
  if (c === 'MAIL_EXPRESS') return 'Mail Express';
  if (c === 'PASSENGER') return 'Passenger';
  return 'any';
}

/** ASC by `editable.lastSignOffTime`; never-signed-off (`null`) goes first. */
function sortByArrival(rows: CrewRow[]): CrewRow[] {
  return rows.slice().sort((a, b) => {
    const at = a.editable.lastSignOffTime;
    const bt = b.editable.lastSignOffTime;
    if (at === null && bt === null) return a.name.localeCompare(b.name);
    if (at === null) return -1;
    if (bt === null) return 1;
    if (at === bt) return a.name.localeCompare(b.name);
    return at < bt ? -1 : 1;
  });
}

function UnlinkedTrains({
  trains,
  assignmentByTrain,
  toStationByTrain,
  lpCategoryById,
  lpEligibleById,
  alpEligibleById,
  lpSignOffById,
  alpSignOffById,
  runDate,
  pendingTrainIds,
}: {
  trains: TrainWithAssignment[];
  assignmentByTrain: Map<string, AssignmentRow>;
  toStationByTrain: Map<string, string>;
  lpCategoryById: Map<string, 'MAIL_EXPRESS' | 'PASSENGER'>;
  lpEligibleById: Map<string, readonly TrainType[]>;
  alpEligibleById: Map<string, readonly TrainType[]>;
  lpSignOffById: Map<string, string | null>;
  alpSignOffById: Map<string, string | null>;
  runDate: string;
  pendingTrainIds: ReadonlySet<string>;
}) {
  return (
    <article
      className="links-board__card links-board__card--unlinked"
      aria-label="Trains not in any link"
    >
      <header className="links-board__card-head">
        <h3 className="links-board__card-title">Trains not in any link</h3>
        <span className="links-board__card-meta">{trains.length} trains</span>
      </header>
      <p className="links-board__unlinked-sub">
        These trains run today but no link rotation covers them. Drop crew
        from the right rail to assign — or open the Assignments tab.
      </p>
      <div className="links-board__rows" role="table">
        <div className="links-board__row links-board__row--head" role="row">
          <span role="columnheader">Dep.</span>
          <span role="columnheader">Train</span>
          <span role="columnheader">LP</span>
          <span role="columnheader">ALP</span>
        </div>
        {trains.map((t) => {
          const a = assignmentByTrain.get(t.number);
          const lpCat = a?.lp ? lpCategoryById.get(a.lp.id) : undefined;
          const lpClass =
            lpCat === 'PASSENGER'
              ? 'lb-pill--passenger'
              : lpCat === 'MAIL_EXPRESS'
                ? 'lb-pill--mail'
                : 'lb-pill--muted';
          const alpRaw = a?.alp;
          const dest = t.onwardToStation ?? toStationByTrain.get(t.number);
          const isPending = pendingTrainIds.has(t.id);
          const lpSlot: DropSlot = {
            kind: 'lp-slot',
            trainId: t.id,
            trainNumber: t.number,
            runDate,
            trainType: t.type,
            departureTime: t.departureTime,
            requiredCategory: null,
            existingAssignmentId: a?.assignmentId ?? null,
            currentCrewId: a?.lp?.id ?? null,
          };
          const alpSlot: DropSlot = {
            kind: 'alp-slot',
            trainId: t.id,
            trainNumber: t.number,
            runDate,
            trainType: t.type,
            departureTime: t.departureTime,
            existingAssignmentId: a?.assignmentId ?? null,
            currentCrewId:
              alpRaw && alpRaw !== 'NOT_REQUIRED' ? alpRaw.id : null,
          };
          // Drag descriptors for assigned LP / ALP. Source carries the
          // assignment id (or null when the row only exists as a staged
          // create-draft) so unassign / move / swap can target the right
          // server endpoint.
          const lpDrag: DragCrew | null =
            a && a.lp
              ? {
                  kind: 'lp',
                  crewId: a.lp.id,
                  crewName: a.lp.name,
                  lpCategory:
                    lpCategoryById.get(a.lp.id) ?? 'MAIL_EXPRESS',
                  lpEligibleTypes: lpEligibleById.get(a.lp.id) ?? [],
                  lastSignOffTime: lpSignOffById.get(a.lp.id) ?? null,
                  source: {
                    kind: 'assignment',
                    assignmentId: a.assignmentId,
                    role: 'lp',
                    trainId: t.id,
                    trainNumber: t.number,
                  },
                }
              : null;
          const alpDrag: DragCrew | null =
            a && alpRaw && alpRaw !== 'NOT_REQUIRED'
              ? {
                  kind: 'alp',
                  crewId: alpRaw.id,
                  crewName: alpRaw.name,
                  alpEligibleTypes: alpEligibleById.get(alpRaw.id) ?? [],
                  lastSignOffTime: alpSignOffById.get(alpRaw.id) ?? null,
                  source: {
                    kind: 'assignment',
                    assignmentId: a.assignmentId,
                    role: 'alp',
                    trainId: t.id,
                    trainNumber: t.number,
                  },
                }
              : null;
          return (
            <div className="links-board__row" role="row" key={t.id}>
              <span className="links-board__pos" role="cell">
                {formatIstTime(new Date(t.departureTime))}
              </span>
              <span className="links-board__trains" role="cell">
                <span
                  className="links-board__train-list"
                  title={`${t.number} → ${dest ?? ''}  ${t.name}`}
                >
                  <span className="links-board__leg links-board__leg--outward">
                    <span className="links-board__leg-num">{t.number}</span>
                    {dest ? (
                      <>
                        <span className="links-board__leg-arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="links-board__leg-dest">{dest}</span>
                      </>
                    ) : null}
                  </span>
                </span>
              </span>
              <span className="links-board__cell" role="cell">
                <DroppableSlot
                  id={`slot:${t.id}:lp`}
                  data={lpSlot}
                  pending={isPending}
                >
                  {a?.lp && lpDrag ? (
                    <DraggableCrew
                      id={`crew:${t.id}:lp:${a.lp.id}`}
                      data={lpDrag}
                      inline
                    >
                      <CrewPill colorClass={lpClass} name={a.lp.name} assigned />
                    </DraggableCrew>
                  ) : (
                    <span className="lb-pill lb-pill--empty">vacant</span>
                  )}
                </DroppableSlot>
              </span>
              <span className="links-board__cell" role="cell">
                {alpRaw === 'NOT_REQUIRED' ? (
                  <span className="lb-pill lb-pill--muted">not required</span>
                ) : (
                  <DroppableSlot
                    id={`slot:${t.id}:alp`}
                    data={alpSlot}
                    pending={isPending}
                  >
                    {alpRaw && alpDrag ? (
                      <DraggableCrew
                        id={`crew:${t.id}:alp:${alpRaw.id}`}
                        data={alpDrag}
                        inline
                      >
                        <CrewPill
                          colorClass="lb-pill--alp"
                          name={alpRaw.name}
                          assigned
                        />
                      </DraggableCrew>
                    ) : (
                      <span className="lb-pill lb-pill--empty">vacant</span>
                    )}
                  </DroppableSlot>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

type RailBucketSet = {
  mailLp: CrewRow[];
  passengerLp: CrewRow[];
  alp: CrewRow[];
};

function bucketSetTotal(b: RailBucketSet): number {
  return b.mailLp.length + b.passengerLp.length + b.alp.length;
}

function CrewRail({
  buckets,
  metaById,
  collapsed,
  onToggleCollapsed,
}: {
  buckets: {
    eligible: RailBucketSet;
    ineligible: RailBucketSet;
  };
  metaById: Map<string, { label: string; title: string }>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const total = bucketSetTotal(buckets.eligible) + bucketSetTotal(buckets.ineligible);
  // Rail itself is still a drop target — only the Eligible section
  // exposes draggable crew. Dropping onto the rail unassigns a pill.
  const railSlot: DropSlot = { kind: 'rail' };
  const { isOver, setNodeRef, active } = useDroppable({
    id: 'rail',
    data: railSlot,
  });
  const drag = active?.data.current as DragCrew | undefined;
  const compatible = drag ? isCompatible(drag, railSlot) : false;
  const cls =
    'links-board__rail' +
    (collapsed ? ' links-board__rail--collapsed' : '') +
    (drag
      ? compatible
        ? isOver
          ? ' links-board__rail--over-ok'
          : ' links-board__rail--accept'
        : ''
      : '');
  // Collapsed: a vertical strip with a chevron to expand and one count
  // chip per bucket tone. Clicking any chip expands the rail.
  if (collapsed) {
    const counts = {
      mail:
        buckets.eligible.mailLp.length + buckets.ineligible.mailLp.length,
      passenger:
        buckets.eligible.passengerLp.length +
        buckets.ineligible.passengerLp.length,
      alp: buckets.eligible.alp.length + buckets.ineligible.alp.length,
    };
    return (
      <aside ref={setNodeRef} className={cls} aria-label="Crew (collapsed)">
        <button
          type="button"
          className="links-board__rail-toggle"
          onClick={onToggleCollapsed}
          title={`Expand crew rail (${total})`}
          aria-label={`Expand crew rail (${total} crew)`}
          aria-expanded={false}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <div className="links-board__rail-stack" aria-hidden="true">
          <button
            type="button"
            className="links-board__rail-chip links-board__rail-chip--mail"
            onClick={onToggleCollapsed}
            title={`Mail LP — ${counts.mail}`}
          >
            <span className="links-board__rail-chip-label">LP</span>
            <span className="links-board__rail-chip-count">{counts.mail}</span>
          </button>
          <button
            type="button"
            className="links-board__rail-chip links-board__rail-chip--passenger"
            onClick={onToggleCollapsed}
            title={`Passenger LP — ${counts.passenger}`}
          >
            <span className="links-board__rail-chip-label">LP</span>
            <span className="links-board__rail-chip-count">
              {counts.passenger}
            </span>
          </button>
          <button
            type="button"
            className="links-board__rail-chip links-board__rail-chip--alp"
            onClick={onToggleCollapsed}
            title={`ALP — ${counts.alp}`}
          >
            <span className="links-board__rail-chip-label">ALP</span>
            <span className="links-board__rail-chip-count">{counts.alp}</span>
          </button>
        </div>
      </aside>
    );
  }
  return (
    <aside ref={setNodeRef} className={cls} aria-label="Crew">
      <header className="links-board__rail-head">
        <h3 className="links-board__rail-title">Crew</h3>
        <span className="links-board__rail-count">{total}</span>
        <button
          type="button"
          className="links-board__rail-toggle links-board__rail-toggle--inline"
          onClick={onToggleCollapsed}
          title="Collapse crew rail"
          aria-label="Collapse crew rail"
          aria-expanded={true}
        >
          <span aria-hidden="true">›</span>
        </button>
      </header>
      <RailSection
        title="Eligible"
        buckets={buckets.eligible}
        metaById={metaById}
        disabled={false}
      />
      <RailSection
        title="Ineligible"
        buckets={buckets.ineligible}
        metaById={metaById}
        disabled={true}
      />
    </aside>
  );
}

function RailSection({
  title,
  buckets,
  metaById,
  disabled,
}: {
  title: string;
  buckets: RailBucketSet;
  metaById: Map<string, { label: string; title: string }>;
  disabled: boolean;
}) {
  const total = bucketSetTotal(buckets);
  return (
    <section
      className={
        'links-board__rail-section' +
        (disabled ? ' links-board__rail-section--disabled' : '')
      }
    >
      <header className="links-board__rail-section-head">
        <h4 className="links-board__rail-section-title">{title}</h4>
        <span className="links-board__rail-count">{total}</span>
      </header>
      <UnassignedBucket
        title="Mail LP"
        tone="mail"
        rows={buckets.mailLp}
        metaById={metaById}
        disabled={disabled}
      />
      <UnassignedBucket
        title="Passenger LP"
        tone="passenger"
        rows={buckets.passengerLp}
        metaById={metaById}
        disabled={disabled}
      />
      <UnassignedBucket
        title="ALP"
        tone="alp"
        rows={buckets.alp}
        metaById={metaById}
        disabled={disabled}
      />
    </section>
  );
}

function UnassignedBucket({
  title,
  tone,
  rows,
  metaById,
  disabled,
}: {
  title: string;
  tone: 'mail' | 'passenger' | 'alp';
  rows: CrewRow[];
  metaById: Map<string, { label: string; title: string }>;
  disabled: boolean;
}) {
  return (
    <section className="links-board__bucket" data-tone={tone}>
      <header className="links-board__bucket-head">
        <span className={`lb-pill lb-pill--${tone}`}>
          {tone === 'alp' ? 'ALP' : 'LP'}
        </span>
        <span className="links-board__bucket-title">{title}</span>
        <span className="links-board__bucket-count">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="links-board__bucket-empty">
          {disabled ? 'None' : 'All assigned'}
        </p>
      ) : (
        <ul className="links-board__bucket-list">
          {rows.map((r) => {
            const meta =
              metaById.get(r.id) ??
              (r.editable.lastSignOffTime
                ? {
                    label: `Off ${formatIstTime(new Date(r.editable.lastSignOffTime))}`,
                    title: r.editable.lastSignOffTime,
                  }
                : { label: 'No prior sign-off', title: 'No recorded sign-off' });
            if (disabled) {
              return (
                <li
                  key={r.id}
                  className="links-board__bucket-item links-board__bucket-item--disabled"
                  aria-disabled="true"
                >
                  <span className="links-board__bucket-name" title={r.name}>
                    {r.name}
                  </span>
                  <span className="links-board__bucket-meta" title={meta.title}>
                    {meta.label}
                  </span>
                </li>
              );
            }
            const drag: DragCrew =
              tone === 'alp'
                ? {
                    kind: 'alp',
                    crewId: r.id,
                    crewName: r.name,
                    alpEligibleTypes: r.editable.eligibleTrainTypes,
                    lastSignOffTime: r.editable.lastSignOffTime,
                    source: { kind: 'rail' },
                  }
                : {
                    kind: 'lp',
                    crewId: r.id,
                    crewName: r.name,
                    lpCategory: tone === 'mail' ? 'MAIL_EXPRESS' : 'PASSENGER',
                    lpEligibleTypes: r.editable.eligibleTrainTypes,
                    lastSignOffTime: r.editable.lastSignOffTime,
                    source: { kind: 'rail' },
                  };
            return (
              <li key={r.id} className="links-board__bucket-item">
                <DraggableCrew id={`crew:${r.id}`} data={drag}>
                  <span className="links-board__bucket-name" title={r.name}>
                    {r.name}
                  </span>
                  <span className="links-board__bucket-meta" title={meta.title}>
                    {meta.label}
                  </span>
                </DraggableCrew>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Legend() {
  return (
    <div className="links-board__legend" aria-hidden="true">
      <span className="links-board__legend-item">
        <span className="lb-pill lb-pill--mail">LP</span> Mail
      </span>
      <span className="links-board__legend-item">
        <span className="lb-pill lb-pill--passenger">LP</span> Passenger
      </span>
      <span className="links-board__legend-item">
        <span className="lb-pill lb-pill--alp">ALP</span>
      </span>
    </div>
  );
}

function BoardCard({
  pair,
  lookup,
  assignmentByTrain,
  prevDayAssignmentByTrain,
  lpCategoryById,
  lpEligibleById,
  alpEligibleById,
  lpSignOffById,
  alpSignOffById,
  lpNameById,
  alpNameById,
  trainById,
  toStationByTrain,
  trainIdByNumber,
  runDate,
  pendingTrainIds,
  planOverriddenTrainIds,
  assignedCrewIds,
  applyRotationDefaults,
  hiddenPrCrewIds,
  hidePrCrew,
  prSlotByKey,
  setPrSlot,
  removePrSlot,
}: {
  pair: BoardPair;
  lookup: Map<string, Map<number, LinkProjectionRow[]>>;
  assignmentByTrain: Map<string, AssignmentRow>;
  prevDayAssignmentByTrain: Map<string, AssignmentRow>;
  lpCategoryById: Map<string, 'MAIL_EXPRESS' | 'PASSENGER'>;
  lpEligibleById: Map<string, readonly TrainType[]>;
  alpEligibleById: Map<string, readonly TrainType[]>;
  lpSignOffById: Map<string, string | null>;
  alpSignOffById: Map<string, string | null>;
  lpNameById: Map<string, string>;
  alpNameById: Map<string, string>;
  trainById: Map<string, TrainWithAssignment>;
  toStationByTrain: Map<string, string>;
  trainIdByNumber: Map<string, string>;
  runDate: string;
  pendingTrainIds: ReadonlySet<string>;
  planOverriddenTrainIds: ReadonlySet<string>;
  assignedCrewIds: ReadonlySet<string>;
  applyRotationDefaults: boolean;
  hiddenPrCrewIds: ReadonlySet<string>;
  hidePrCrew: (crewId: string) => void;
  prSlotByKey: ReadonlyMap<string, LinksPlanPrSlot>;
  setPrSlot: (
    linkId: string,
    positionNumber: number,
    patch: Partial<LinksPlanPrSlot>,
  ) => void;
  removePrSlot: (linkId: string, positionNumber: number) => void;
}) {
  const lpById = lookup.get(pair.lp.id);
  const alpById = pair.alp ? lookup.get(pair.alp.id) : undefined;

  return (
    <article className="links-board__card">
      <header className="links-board__card-head">
        <h3 className="links-board__card-title">{pair.title}</h3>
        <span className="links-board__card-meta">
          {pair.lp.cycleLength} positions
        </span>
      </header>

      <div className="links-board__rows" role="table">
        <div className="links-board__row links-board__row--head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Train</span>
          <span role="columnheader">LP</span>
          <span role="columnheader">ALP</span>
        </div>

        {pair.lp.positions.map((pos) => {
          const rawProjectedLp = lpById?.get(pos.positionNumber)?.[0];
          const rawProjectedAlp = alpById?.get(pos.positionNumber)?.[0];
          // On PR rows, a crew that's now assigned to a train today
          // can't simultaneously be resting — hide their projected pill
          // so dragging a PR pill onto a DUTY slot visibly removes it
          // from the PR row (the slot fill is the new home of truth).
          //
          // When `applyRotationDefaults` is off, the operator wants a
          // blank canvas — suppress BOTH DUTY-row and PR-row rotation
          // projections entirely. Nothing is pre-filled; everything
          // comes from the rail via drag-and-drop.
          const projectedLp =
            !applyRotationDefaults
              ? undefined
              : pos.kind === 'PR' && rawProjectedLp && assignedCrewIds.has(rawProjectedLp.crewId)
                ? undefined
                : pos.kind === 'PR' && rawProjectedLp && hiddenPrCrewIds.has(rawProjectedLp.crewId)
                  ? undefined
                  : rawProjectedLp;
          const projectedAlp =
            !applyRotationDefaults
              ? undefined
              : pos.kind === 'PR' && rawProjectedAlp && assignedCrewIds.has(rawProjectedAlp.crewId)
                ? undefined
                : pos.kind === 'PR' && rawProjectedAlp && hiddenPrCrewIds.has(rawProjectedAlp.crewId)
                  ? undefined
                  : rawProjectedAlp;

          // Resolve which assignment row drives this position's crew pills.
          // Default: the same-day assignment for the position's first train.
          // Override: if the first segment is INWARD, use the paired OUTWARD
          // train's assignment (same-day or prev-day, per pair kind) so the
          // operator sees the actual crew that's running through.
          const firstSeg =
            pos.kind === 'DUTY' ? pos.segments[0] : undefined;
          let assignment: AssignmentRow | undefined;
          if (firstSeg) {
            if (firstSeg.direction === 'inward') {
              const pairResult = findOutwardPair(pair.lp, pos.positionNumber, 0);
              if (pairResult) {
                const map =
                  pairResult.pairKind === 'overnight'
                    ? prevDayAssignmentByTrain
                    : assignmentByTrain;
                assignment = map.get(pairResult.outward.trainNumber);
              }
            }
            // Fall back to same-day own assignment if pair lookup didn't
            // resolve (untagged data, missing prev-day, etc.).
            if (!assignment) {
              assignment = assignmentByTrain.get(firstSeg.trainNumber);
            }
          }

          // The trainId this row is showing crew for. Used to suppress
          // the rotation projection when the operator's plan has an
          // explicit entry for this train (so an emptied slot stays
          // empty even on rows without a live assignment).
          const rowTrainNumber = firstSeg?.trainNumber;
          const rowTrainId = rowTrainNumber
            ? trainIdByNumber.get(rowTrainNumber)
            : undefined;
          const rowOverridden = rowTrainId
            ? planOverriddenTrainIds.has(rowTrainId)
            : false;

          const lpResolved = resolveLp(
            assignment,
            rowOverridden ? undefined : projectedLp,
            lpCategoryById,
          );
          const alpResolved = resolveAlp(
            assignment,
            rowOverridden ? undefined : projectedAlp,
          );

          // Color falls back to the link's intent when no crew is known.
          const lpClass =
            lpResolved?.category === 'PASSENGER'
              ? 'lb-pill--passenger'
              : lpResolved?.category === 'MAIL_EXPRESS'
                ? 'lb-pill--mail'
                : pair.lp.lpCategory === 'PASSENGER'
                  ? 'lb-pill--passenger'
                  : 'lb-pill--mail';

          // Drop targets: only DUTY positions whose first leg is the
          // outward depot sign-on (or has no direction tag). Inward-first
          // rows represent returning crew chained from a prior assignment
          // and don't take their own sign-on — skip them.
          const isOutwardDuty =
            pos.kind === 'DUTY' &&
            firstSeg !== undefined &&
            firstSeg.direction !== 'inward';
          // PR rows have no train and aren't drop targets, but their
          // projected crew should still be draggable so the operator can
          // pull a resting crew member onto a DUTY slot or back to the
          // rail. OFF stays inert.
          const isDragSource = isOutwardDuty || pos.kind === 'PR';
          const targetTrainNumber = firstSeg?.trainNumber;
          const targetTrainId = targetTrainNumber
            ? trainIdByNumber.get(targetTrainNumber)
            : undefined;
          const isPending = targetTrainId
            ? pendingTrainIds.has(targetTrainId)
            : false;
          const liveAssignment = assignmentByTrain.get(targetTrainNumber ?? '');
          const liveAlp =
            liveAssignment?.alp && liveAssignment.alp !== 'NOT_REQUIRED'
              ? liveAssignment.alp
              : null;

          // Slots are always droppable for outward-DUTY positions (so
          // assigned-pill drops can replace / swap). The handler resolves
          // empty-vs-occupied based on `currentCrewId`.
          const lpSlotEnabled =
            isOutwardDuty && Boolean(targetTrainId) && Boolean(targetTrainNumber);
          const alpSlotEnabled =
            isOutwardDuty &&
            Boolean(targetTrainId) &&
            Boolean(targetTrainNumber) &&
            Boolean(pair.alp);

          const lpSlot: DropSlot | null =
            lpSlotEnabled && targetTrainId && targetTrainNumber
              ? (() => {
                  const t = trainById.get(targetTrainId);
                  if (!t) return null;
                  return {
                    kind: 'lp-slot',
                    trainId: targetTrainId,
                    trainNumber: targetTrainNumber,
                    runDate,
                    trainType: t.type,
                    departureTime: t.departureTime,
                    requiredCategory: pair.lp.lpCategory ?? null,
                    existingAssignmentId: liveAssignment?.assignmentId ?? null,
                    currentCrewId: liveAssignment?.lp?.id ?? null,
                    defaultAlpId: projectedAlp?.crewId ?? null,
                  };
                })()
              : null;
          const alpSlot: DropSlot | null =
            alpSlotEnabled && targetTrainId && targetTrainNumber
              ? (() => {
                  const t = trainById.get(targetTrainId);
                  if (!t) return null;
                  return {
                    kind: 'alp-slot',
                    trainId: targetTrainId,
                    trainNumber: targetTrainNumber,
                    runDate,
                    trainType: t.type,
                    departureTime: t.departureTime,
                    existingAssignmentId: liveAssignment?.assignmentId ?? null,
                    defaultLpId: projectedLp?.crewId ?? null,
                    currentCrewId: liveAlp?.id ?? null,
                  };
                })()
              : null;

          // Drag descriptors for LP / ALP on THIS row's assignment. The
          // assignment may be a live committed row or a staged-create
          // draft (assignmentId = null); the rail-drop handler picks the
          // right server call from the source.
          const lpDrag: DragCrew | null =
            liveAssignment?.lp && targetTrainId && targetTrainNumber
              ? {
                  kind: 'lp',
                  crewId: liveAssignment.lp.id,
                  crewName: liveAssignment.lp.name,
                  lpCategory:
                    lpCategoryById.get(liveAssignment.lp.id) ??
                    pair.lp.lpCategory ??
                    'MAIL_EXPRESS',
                  lpEligibleTypes:
                    lpEligibleById.get(liveAssignment.lp.id) ?? [],
                  lastSignOffTime:
                    lpSignOffById.get(liveAssignment.lp.id) ?? null,
                  source: {
                    kind: 'assignment',
                    assignmentId: liveAssignment.assignmentId,
                    role: 'lp',
                    trainId: targetTrainId,
                    trainNumber: targetTrainNumber,
                  },
                }
              : null;
          const alpDrag: DragCrew | null =
            liveAlp && liveAssignment && targetTrainId && targetTrainNumber
              ? {
                  kind: 'alp',
                  crewId: liveAlp.id,
                  crewName: liveAlp.name,
                  alpEligibleTypes: alpEligibleById.get(liveAlp.id) ?? [],
                  lastSignOffTime: alpSignOffById.get(liveAlp.id) ?? null,
                  source: {
                    kind: 'assignment',
                    assignmentId: liveAssignment.assignmentId,
                    role: 'alp',
                    trainId: targetTrainId,
                    trainNumber: targetTrainNumber,
                  },
                }
              : null;

          // Fallback drag descriptors for PROJECTED (rotation-suggested,
          // not yet live-assigned) crew. Source is `rail` because there's
          // no assignment to clear — dropping the pill elsewhere just
          // creates a fresh assignment using that crew id.
          const projectedLpDrag: DragCrew | null =
            !lpDrag && projectedLp
              ? {
                  kind: 'lp',
                  crewId: projectedLp.crewId,
                  crewName: projectedLp.crewName,
                  lpCategory:
                    projectedLp.lpCategory ??
                    pair.lp.lpCategory ??
                    'MAIL_EXPRESS',
                  lpEligibleTypes:
                    lpEligibleById.get(projectedLp.crewId) ?? [],
                  lastSignOffTime:
                    lpSignOffById.get(projectedLp.crewId) ?? null,
                  source: {
                    kind: 'rail',
                    ...(targetTrainId && targetTrainNumber
                      ? {
                          projectedFrom: {
                            trainId: targetTrainId,
                            trainNumber: targetTrainNumber,
                            role: 'lp',
                          },
                        }
                      : {}),
                  },
                }
              : null;
          const projectedAlpDrag: DragCrew | null =
            !alpDrag && projectedAlp
              ? {
                  kind: 'alp',
                  crewId: projectedAlp.crewId,
                  crewName: projectedAlp.crewName,
                  alpEligibleTypes:
                    alpEligibleById.get(projectedAlp.crewId) ?? [],
                  lastSignOffTime:
                    alpSignOffById.get(projectedAlp.crewId) ?? null,
                  source: {
                    kind: 'rail',
                    ...(targetTrainId && targetTrainNumber
                      ? {
                          projectedFrom: {
                            trainId: targetTrainId,
                            trainNumber: targetTrainNumber,
                            role: 'alp',
                          },
                        }
                      : {}),
                  },
                }
              : null;

          const lpPillCore = lpResolved ? (
            <CrewPill
              colorClass={lpClass}
              name={lpResolved.name}
              assigned={lpResolved.assigned}
            />
          ) : (
            <span className="lb-pill lb-pill--empty">vacant</span>
          );
          const lpDragForPill = isDragSource ? (lpDrag ?? projectedLpDrag) : null;
          const lpPill =
            lpResolved && lpDragForPill ? (
              <DraggableCrew
                id={`crew:${targetTrainId}:lp:${lpDragForPill.crewId}`}
                data={lpDragForPill}
                inline
              >
                {lpPillCore}
              </DraggableCrew>
            ) : (
              lpPillCore
            );
          const alpPillCore =
            alpResolved || (pos.kind === 'DUTY' && pair.alp) ? (
              <CrewPill
                colorClass="lb-pill--alp"
                name={alpResolved?.name}
                assigned={alpResolved?.assigned ?? false}
              />
            ) : (
              <span className="lb-pill lb-pill--empty">vacant</span>
            );
          const alpDragForPill = isDragSource ? (alpDrag ?? projectedAlpDrag) : null;
          const alpPill =
            alpResolved && alpDragForPill ? (
              <DraggableCrew
                id={`crew:${targetTrainId}:alp:${alpDragForPill.crewId}`}
                data={alpDragForPill}
                inline
              >
                {alpPillCore}
              </DraggableCrew>
            ) : (
              alpPillCore
            );

          // PR row override (if any) for this position. The override
          // map is keyed by `${linkId}:p${positionNumber}` and wins
          // over the rotation projection in the PR cells below.
          const prKey = pos.kind === 'PR' ? prSlotKey(pair.lp.id, pos.positionNumber) : null;
          const prOverride = prKey ? prSlotByKey.get(prKey) : undefined;
          const prOverrideLpName = prOverride?.lpId
            ? lpNameById.get(prOverride.lpId) ?? prOverride.lpId
            : null;
          const prOverrideAlpName = prOverride?.alpId
            ? alpNameById.get(prOverride.alpId) ?? prOverride.alpId
            : null;
          const clearPrRole = (role: 'lp' | 'alp') => {
            const cur = prOverride;
            const otherStillSet =
              role === 'lp' ? cur?.alpId != null : cur?.lpId != null;
            if (!otherStillSet) {
              removePrSlot(pair.lp.id, pos.positionNumber);
            } else {
              setPrSlot(
                pair.lp.id,
                pos.positionNumber,
                role === 'lp' ? { lpId: null } : { alpId: null },
              );
            }
          };
          const prLpDropSlot: DropSlot | null =
            pos.kind === 'PR'
              ? {
                  kind: 'pr-lp-slot',
                  linkId: pair.lp.id,
                  positionNumber: pos.positionNumber,
                  currentCrewId: prOverride?.lpId ?? projectedLp?.crewId ?? null,
                }
              : null;
          const prAlpDropSlot: DropSlot | null =
            pos.kind === 'PR' && pair.alp
              ? {
                  kind: 'pr-alp-slot',
                  linkId: pair.lp.id,
                  positionNumber: pos.positionNumber,
                  currentCrewId: prOverride?.alpId ?? projectedAlp?.crewId ?? null,
                }
              : null;

          return (
            <div
              className={`links-board__row${
                firstSeg?.direction === 'inward' ? ' links-board__row--inward' : ''
              }`}
              role="row"
              key={pos.positionNumber}
            >
              <span className="links-board__pos" role="cell">
                {pos.positionNumber}
              </span>
              <span className="links-board__trains" role="cell">
                <PositionTrains
                  position={pos}
                  toStationByTrain={toStationByTrain}
                />
              </span>
              <span className="links-board__cell" role="cell">
                {lpSlot ? (
                  <DroppableSlot
                    id={`slot:${pair.lp.id}:${pos.positionNumber}:lp`}
                    data={lpSlot}
                    pending={isPending}
                  >
                    {lpPill}
                  </DroppableSlot>
                ) : prLpDropSlot ? (
                  <DroppableSlot
                    id={`prslot:${pair.lp.id}:${pos.positionNumber}:lp`}
                    data={prLpDropSlot}
                    pending={false}
                  >
                    {prOverrideLpName ? (
                      <span className="links-board__pr-wrap">
                        <CrewPill
                          colorClass={lpClass}
                          name={prOverrideLpName}
                          assigned
                        />
                        <button
                          type="button"
                          className="links-board__pr-dismiss"
                          title={`Clear ${prOverrideLpName} from this PR slot`}
                          aria-label={`Clear ${prOverrideLpName} from PR`}
                          onClick={() => clearPrRole('lp')}
                        >
                          ×
                        </button>
                      </span>
                    ) : projectedLp ? (
                      <span className="links-board__pr-wrap">
                        {lpPill}
                        <button
                          type="button"
                          className="links-board__pr-dismiss"
                          title={`Hide ${projectedLp.crewName} from today's PR projection`}
                          aria-label={`Hide ${projectedLp.crewName} from PR`}
                          onClick={() => hidePrCrew(projectedLp.crewId)}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className="lb-pill lb-pill--empty">vacant</span>
                    )}
                  </DroppableSlot>
                ) : (
                  lpPill
                )}
              </span>
              <span className="links-board__cell" role="cell">
                {alpSlot ? (
                  <DroppableSlot
                    id={`slot:${pair.lp.id}:${pos.positionNumber}:alp`}
                    data={alpSlot}
                    pending={isPending}
                  >
                    {alpPill}
                  </DroppableSlot>
                ) : prAlpDropSlot ? (
                  <DroppableSlot
                    id={`prslot:${pair.lp.id}:${pos.positionNumber}:alp`}
                    data={prAlpDropSlot}
                    pending={false}
                  >
                    {prOverrideAlpName ? (
                      <span className="links-board__pr-wrap">
                        <CrewPill
                          colorClass="lb-pill--alp"
                          name={prOverrideAlpName}
                          assigned
                        />
                        <button
                          type="button"
                          className="links-board__pr-dismiss"
                          title={`Clear ${prOverrideAlpName} from this PR slot`}
                          aria-label={`Clear ${prOverrideAlpName} from PR`}
                          onClick={() => clearPrRole('alp')}
                        >
                          ×
                        </button>
                      </span>
                    ) : projectedAlp ? (
                      <span className="links-board__pr-wrap">
                        {alpPill}
                        <button
                          type="button"
                          className="links-board__pr-dismiss"
                          title={`Hide ${projectedAlp.crewName} from today's PR projection`}
                          aria-label={`Hide ${projectedAlp.crewName} from PR`}
                          onClick={() => hidePrCrew(projectedAlp.crewId)}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className="lb-pill lb-pill--empty">vacant</span>
                    )}
                  </DroppableSlot>
                ) : (
                  alpPill
                )}
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

/**
 * Resolve which LP to show in a row. Active assignment wins; falls back
 * to the link's projected crew. `assigned: true` lets the UI mark the
 * pill as committed.
 */
function resolveLp(
  assignment: AssignmentRow | undefined,
  projected: LinkProjectionRow | undefined,
  categoryById: Map<string, 'MAIL_EXPRESS' | 'PASSENGER'>,
): { name: string; category?: 'MAIL_EXPRESS' | 'PASSENGER'; assigned: boolean } | undefined {
  if (assignment?.lp) {
    const cat = categoryById.get(assignment.lp.id);
    return { name: assignment.lp.name, ...(cat ? { category: cat } : {}), assigned: true };
  }
  if (projected) {
    return {
      name: projected.crewName,
      ...(projected.lpCategory ? { category: projected.lpCategory } : {}),
      assigned: false,
    };
  }
  return undefined;
}

function resolveAlp(
  assignment: AssignmentRow | undefined,
  projected: LinkProjectionRow | undefined,
): { name: string; assigned: boolean } | undefined {
  if (assignment) {
    const a = assignment.alp;
    if (a && a !== 'NOT_REQUIRED') return { name: a.name, assigned: true };
    if (a === 'NOT_REQUIRED') return undefined;
  }
  if (projected) return { name: projected.crewName, assigned: false };
  return undefined;
}

function PositionTrains({
  position,
  toStationByTrain,
}: {
  position: LinkPositionRow;
  toStationByTrain: Map<string, string>;
}) {
  if (position.kind === 'OFF') {
    return <span className="lb-tag lb-tag--off">OFF</span>;
  }
  if (position.kind === 'PR') {
    return <span className="lb-tag lb-tag--pr">PR</span>;
  }
  const segs = position.segments;
  const first = segs[0];
  if (!first) return <span className="lb-pill lb-pill--muted">—</span>;
  const fullTitle = segs
    .map((s) => {
      const dest = s.toStation ?? toStationByTrain.get(s.trainNumber);
      return dest ? `${s.trainNumber} → ${dest}` : s.trainNumber;
    })
    .join('  /  ');

  return (
    <span className="links-board__train-list" title={fullTitle}>
      {segs.map((s, i) => {
        const dest = s.toStation ?? toStationByTrain.get(s.trainNumber);
        const dir = s.direction ?? 'conti';
        const dirTitle =
          dir === 'outward'
            ? 'Depot-leaving leg'
            : dir === 'inward'
              ? 'Depot-arriving leg'
              : 'Mid-trip continuation';
        return (
          <span
            key={`${s.trainNumber}-${i}`}
            className={`links-board__leg links-board__leg--${dir}`}
            title={dirTitle}
          >
            {i > 0 ? (
              <span className="links-board__seg-join" aria-hidden="true">
                →
              </span>
            ) : null}
            <span className="links-board__leg-num">{s.trainNumber}</span>
            {dest ? (
              <>
                <span className="links-board__leg-arrow" aria-hidden="true">
                  →
                </span>
                <span className="links-board__leg-dest">{dest}</span>
              </>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** `YYYY-MM-DD` (IST) minus one day. Pure: parses via `Date.UTC`. */
function previousIsoDate(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d) - 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function CrewPill({
  colorClass,
  name,
  assigned,
}: {
  colorClass: string;
  name?: string;
  assigned: boolean;
}) {
  if (!name) {
    return <span className="lb-pill lb-pill--empty">vacant</span>;
  }
  const title = assigned ? `${name} — assigned` : `${name} — from link`;
  const cls = `lb-pill ${colorClass}${assigned ? ' lb-pill--assigned' : ''}`;
  return (
    <span className={cls} title={title}>
      {assigned ? <span className="lb-pill__dot" aria-hidden="true" /> : null}
      {name}
    </span>
  );
}

// ----- DnD wrappers --------------------------------------------------------
// Thin adapters around `useDraggable` / `useDroppable` so the existing JSX
// stays readable. Hover state encodes whether the active drag is compatible
// with this slot — green ring for compatible, red ring for blocked.

function DraggableCrew({
  id,
  data,
  inline = false,
  children,
}: {
  id: string;
  data: DragCrew;
  /** Render as an inline-flex span (for pill wrapping) instead of a block div. */
  inline?: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data,
  });
  const className =
    'links-board__drag-handle' +
    (inline ? ' links-board__drag-handle--inline' : '');
  const style = { opacity: isDragging ? 0.4 : 1, cursor: 'grab' as const };
  if (inline) {
    return (
      <span
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className={className}
        style={style}
      >
        {children}
      </span>
    );
  }
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={className}
      style={style}
    >
      {children}
    </div>
  );
}

function DroppableSlot({
  id,
  data,
  pending,
  children,
}: {
  id: string;
  data: DropSlot;
  pending: boolean;
  children: ReactNode;
}) {
  // Compute eligibility BEFORE calling useDroppable so the slot can
  // declare itself disabled when an incompatible drag is in flight —
  // the user sees only valid drop targets light up.
  const { active: peekActive } = useDndContext();
  const peekDrag = peekActive?.data.current as DragCrew | undefined;
  const slotDisabled = peekDrag ? !isCompatible(peekDrag, data) : false;
  const { isOver, setNodeRef, active } = useDroppable({ id, data, disabled: slotDisabled });
  const drag = active?.data.current as DragCrew | undefined;
  const compatible = drag ? isCompatible(drag, data) : false;
  const cls =
    'links-board__slot' +
    (peekDrag
      ? compatible
        ? isOver
          ? ' links-board__slot--over-ok'
          : ' links-board__slot--accept'
        : ' links-board__slot--reject'
      : '') +
    (pending ? ' links-board__slot--pending' : '');
  return (
    <span ref={setNodeRef} className={cls}>
      {children}
    </span>
  );
}

function buildLookup(
  rows: ReadonlyArray<LinkProjectionRow>,
): Map<string, Map<number, LinkProjectionRow[]>> {
  const out = new Map<string, Map<number, LinkProjectionRow[]>>();
  for (const r of rows) {
    let byPos = out.get(r.linkId);
    if (!byPos) {
      byPos = new Map();
      out.set(r.linkId, byPos);
    }
    const list = byPos.get(r.positionNumber) ?? [];
    list.push(r);
    byPos.set(r.positionNumber, list);
  }
  return out;
}

// Pairing key: cycle length + ordered sequence of position kinds. Mirror
// links (LP mail ↔ ALP mail) share the same schedule shape, which is the
// invariant we rely on.
function shapeKey(link: LinkRow): string {
  return `${link.cycleLength}:${link.positions.map((p) => p.kind).join(',')}`;
}

function shortTitle(link: LinkRow): string {
  if (link.lpCategory === 'MAIL_EXPRESS') return 'Mail Express';
  if (link.lpCategory === 'PASSENGER') return 'Passenger';
  // ALP link — infer from name keyword.
  const n = link.name.toUpperCase();
  if (n.includes('MAIL')) return 'Mail Express';
  if (n.includes('PASSENGER')) return 'Passenger';
  return link.name;
}

function pairLinks(links: ReadonlyArray<LinkRow>): BoardPair[] {
  const lps = links.filter((l) => l.crewRole === 'LP');
  const alps = links.filter((l) => l.crewRole === 'ALP');
  const alpByShape = new Map<string, LinkRow>();
  for (const a of alps) alpByShape.set(shapeKey(a), a);

  const pairs: BoardPair[] = [];
  const claimedAlpIds = new Set<string>();

  for (const lp of lps) {
    const mirror = alpByShape.get(shapeKey(lp));
    if (mirror) claimedAlpIds.add(mirror.id);
    pairs.push({
      key: lp.id,
      title: shortTitle(lp),
      lp,
      ...(mirror ? { alp: mirror } : {}),
    });
  }

  // Orphan ALP links (no LP mirror) — render as their own card with the
  // ALP column populated and an empty "LP" column. Rare but handled.
  for (const a of alps) {
    if (claimedAlpIds.has(a.id)) continue;
    pairs.push({
      key: a.id,
      title: `${shortTitle(a)} (ALP only)`,
      lp: a, // structurally OK: positions array drives the rows
    });
  }

  // Sort: Mail before Passenger, LP-with-mirror before orphans.
  pairs.sort((a, b) => a.title.localeCompare(b.title));
  return pairs;
}
