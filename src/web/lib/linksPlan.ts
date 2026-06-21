//
// Browser-local "scratchpad" for the Links board. The user mutates this
// plan via DnD without touching the server; clicking "Auto-Draft from
// links" later flushes the diff to the assignment-drafts cart in one
// batch. See AGENTS.md / HLD §4.12 for the broader workflow.
//
// Scope rules (matches the orchestrator):
//   - Plan covers OUTWARD DUTY trains only. Inward LP/ALP is derived
//     on-the-fly from its paired outward and is not stored.
//   - `lpId`, `alpId`, `alpId2` may each be null \u2014 the operator can
//     leave any combination empty (no LP-required-first rule on the
//     client; validation runs on sync).
//   - `origin` distinguishes rotation-seeded slots from operator-placed
//     ones, useful for "reset to rotation" and dirty-marker UX.

import { useCallback, useEffect, useState } from 'react';
import type {
  AssignmentRow,
  AssignmentDraftStageInput,
} from '../../shared/schemas';

/** Minimal crew shape the diff needs — just the display name. */
interface NamedCrew {
  id: string;
  name: string;
}

const STORAGE_PREFIX = 'rpms.linksPlan.';

export type SlotOrigin = 'auto' | 'manual';

export interface LinksPlanSlot {
  lpId: string | null;
  alpId: string | null;
  alpId2: string | null;
  origin: SlotOrigin;
}

/**
 * Per-position override for a PR (Periodic Rest) row. Keyed by
 * `${linkId}:p${positionNumber}` inside `LinksPlan.prSlots`. When
 * present, this overrides whatever the rotation would have projected
 * onto that PR row — the operator can substitute another crew or
 * explicitly null the role.
 */
export interface LinksPlanPrSlot {
  lpId: string | null;
  alpId: string | null;
}

export function prSlotKey(linkId: string, positionNumber: number): string {
  return `${linkId}:p${positionNumber}`;
}

export interface LinksPlan {
  runDate: string;
  /** trainId \u2192 slot. Only outward DUTY trains live here. */
  slots: Record<string, LinksPlanSlot>;
  /** `${linkId}:p${positionNumber}` \u2192 PR override. */
  prSlots: Record<string, LinksPlanPrSlot>;
  /**
   * Projected-PR crew ids the operator has dismissed for this run
   * date. PR pills on board cards check this list and render nothing
   * when their crew id is present. The list survives reload because it
   * lives inside the plan, alongside slot overrides.
   */
  hiddenPrCrewIds: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function storageKey(runDate: string): string {
  return `${STORAGE_PREFIX}${runDate}`;
}

export function loadPlan(runDate: string): LinksPlan | null {
  try {
    const raw = window.localStorage.getItem(storageKey(runDate));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LinksPlan> & {
      runDate?: string;
      slots?: Record<string, LinksPlanSlot>;
    };
    if (!parsed || parsed.runDate !== runDate || typeof parsed.slots !== 'object') {
      return null;
    }
    // Back-compat: older plans persisted without `hiddenPrCrewIds` or `prSlots`.
    return {
      runDate: parsed.runDate,
      slots: parsed.slots,
      prSlots:
        parsed.prSlots && typeof parsed.prSlots === 'object'
          ? (parsed.prSlots as Record<string, LinksPlanPrSlot>)
          : {},
      hiddenPrCrewIds: Array.isArray(parsed.hiddenPrCrewIds)
        ? parsed.hiddenPrCrewIds.filter((s): s is string => typeof s === 'string')
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function savePlan(plan: LinksPlan): void {
  try {
    window.localStorage.setItem(storageKey(plan.runDate), JSON.stringify(plan));
  } catch {
    // Quota or private-mode failure \u2014 fail silently; the in-memory
    // copy is still authoritative for the session.
  }
}

export function deletePlan(runDate: string): void {
  try {
    window.localStorage.removeItem(storageKey(runDate));
  } catch {
    // ignore
  }
}

/** Drop plans older than `maxAgeDays`. Called on mount to keep storage tidy. */
export function pruneOldPlans(maxAgeDays = 30): void {
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as LinksPlan;
        const t = Date.parse(parsed.updatedAt ?? '');
        if (Number.isFinite(t) && t < cutoff) toRemove.push(key);
      } catch {
        toRemove.push(key);
      }
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// mutation helpers \u2014 immutable updates; caller assigns the result back.
// ---------------------------------------------------------------------------

export function emptySlot(origin: SlotOrigin = 'manual'): LinksPlanSlot {
  return { lpId: null, alpId: null, alpId2: null, origin };
}

export function withSlot(
  plan: LinksPlan,
  trainId: string,
  patch: Partial<LinksPlanSlot>,
  origin: SlotOrigin = 'manual',
): LinksPlan {
  const prev = plan.slots[trainId] ?? emptySlot(origin);
  const next: LinksPlanSlot = {
    lpId: patch.lpId !== undefined ? patch.lpId : prev.lpId,
    alpId: patch.alpId !== undefined ? patch.alpId : prev.alpId,
    alpId2: patch.alpId2 !== undefined ? patch.alpId2 : prev.alpId2,
    origin,
  };
  return {
    ...plan,
    slots: { ...plan.slots, [trainId]: next },
    updatedAt: new Date().toISOString(),
  };
}

export function clearSlot(plan: LinksPlan, trainId: string): LinksPlan {
  if (!plan.slots[trainId]) return plan;
  const slots = { ...plan.slots };
  delete slots[trainId];
  return { ...plan, slots, updatedAt: new Date().toISOString() };
}

/**
 * Remove the given crew id from any slot it occupies. Used when the
 * operator drags a pill from slot A to slot B \u2014 A vacates the crew
 * before B receives it. `exceptTrainId` keeps the target slot intact
 * after the receive step.
 */
export function vacateCrew(
  plan: LinksPlan,
  crewId: string,
  exceptTrainId?: string,
): LinksPlan {
  let changed = false;
  const slots: Record<string, LinksPlanSlot> = {};
  for (const [trainId, slot] of Object.entries(plan.slots)) {
    if (trainId === exceptTrainId) {
      slots[trainId] = slot;
      continue;
    }
    const lpHit = slot.lpId === crewId;
    const alpHit = slot.alpId === crewId;
    const alp2Hit = slot.alpId2 === crewId;
    if (lpHit || alpHit || alp2Hit) {
      changed = true;
      slots[trainId] = {
        ...slot,
        lpId: lpHit ? null : slot.lpId,
        alpId: alpHit ? null : slot.alpId,
        alpId2: alp2Hit ? null : slot.alpId2,
        origin: 'manual',
      };
    } else {
      slots[trainId] = slot;
    }
  }
  if (!changed) return plan;
  return { ...plan, slots, updatedAt: new Date().toISOString() };
}

/**
 * Append a crew id to the per-date hidden-PR list. Used by the board's
 * PR pill ✕ affordance to dismiss a projected PR entry. No-op if the
 * id is already present.
 */
export function withHiddenPrCrew(plan: LinksPlan, crewId: string): LinksPlan {
  if (plan.hiddenPrCrewIds.includes(crewId)) return plan;
  return {
    ...plan,
    hiddenPrCrewIds: [...plan.hiddenPrCrewIds, crewId],
    updatedAt: new Date().toISOString(),
  };
}

/** Drop the given crew id from the hidden-PR list (un-hide). */
export function withoutHiddenPrCrew(plan: LinksPlan, crewId: string): LinksPlan {
  if (!plan.hiddenPrCrewIds.includes(crewId)) return plan;
  return {
    ...plan,
    hiddenPrCrewIds: plan.hiddenPrCrewIds.filter((id) => id !== crewId),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Patch a PR row override. `null` for a role = explicitly empty,
 * `undefined` = leave that role unchanged. Vacates the new crew id
 * from every other PR override first, mirroring how `vacateCrew`
 * keeps DUTY assignments unique.
 */
export function withPrSlot(
  plan: LinksPlan,
  linkId: string,
  positionNumber: number,
  patch: Partial<LinksPlanPrSlot>,
): LinksPlan {
  const key = prSlotKey(linkId, positionNumber);
  const prev = plan.prSlots[key] ?? { lpId: null, alpId: null };
  const next: LinksPlanPrSlot = {
    lpId: patch.lpId !== undefined ? patch.lpId : prev.lpId,
    alpId: patch.alpId !== undefined ? patch.alpId : prev.alpId,
  };
  // Vacate the new crew id from any other PR slot so a single crew
  // can't appear in two PR rows at once.
  const prSlots: Record<string, LinksPlanPrSlot> = {};
  for (const [k, v] of Object.entries(plan.prSlots)) {
    if (k === key) continue;
    const lpHit = next.lpId !== null && v.lpId === next.lpId;
    const alpHit = next.alpId !== null && v.alpId === next.alpId;
    if (lpHit || alpHit) {
      prSlots[k] = {
        lpId: lpHit ? null : v.lpId,
        alpId: alpHit ? null : v.alpId,
      };
    } else {
      prSlots[k] = v;
    }
  }
  prSlots[key] = next;
  return { ...plan, prSlots, updatedAt: new Date().toISOString() };
}

/** Drop a PR row override entirely (rotation projection re-renders). */
export function clearPrSlot(
  plan: LinksPlan,
  linkId: string,
  positionNumber: number,
): LinksPlan {
  const key = prSlotKey(linkId, positionNumber);
  if (!plan.prSlots[key]) return plan;
  const prSlots = { ...plan.prSlots };
  delete prSlots[key];
  return { ...plan, prSlots, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// sync \u2192 server draft cart
// ---------------------------------------------------------------------------

/**
 * One unit of work emitted by `diffPlanVsServer`. The Sync handler
 * dispatches each op to `assignmentDrafts.upsert` (create/update) or
 * `assignmentDrafts.remove` (cancel a draft) or `delete` draft (remove
 * a live assignment).
 */
export type PlanSyncOp =
  | { kind: 'upsert'; draft: AssignmentDraftStageInput }
  | { kind: 'remove-draft'; trainId: string; runDate: string };

export interface TrainMeta {
  id: string;
  number: string;
  name: string;
  type: AssignmentRow['trainType'];
  /** ISO-8601 UTC string with offset — matches `AssignmentRow.departureTime`. */
  departureTime: string;
}

export interface DiffInputs {
  runDate: string;
  /**
   * Effective crew slot per trainId — the COMPOSED view of rotation
   * defaults overlaid with operator overrides from the plan. The board
   * builds this map in a useMemo and passes it both to render and to
   * sync, so the two views can never disagree.
   */
  effectiveSlots: ReadonlyMap<string, LinksPlanSlot>;
  /** Live assignments for the run date, keyed by trainId. */
  assignmentsByTrainId: ReadonlyMap<string, AssignmentRow>;
  /**
   * Existing server-side drafts for the run date, keyed by trainId.
   * Used to avoid no-op upserts and to know when a slot edit must emit
   * a `remove-draft` rather than nothing.
   */
  draftsByTrainId: ReadonlyMap<string, AssignmentDraftStageInput>;
  /** Per-train metadata for synthesising drafts. */
  trainById: ReadonlyMap<string, TrainMeta>;
  lpById: ReadonlyMap<string, NamedCrew>;
  alpById: ReadonlyMap<string, NamedCrew>;
}

/**
 * Diff the browser plan against the server's view (live assignments +
 * existing drafts) and emit the minimum set of API calls needed to make
 * the server reflect the plan.
 */
export function diffPlanVsServer(inputs: DiffInputs): PlanSyncOp[] {
  const { runDate, effectiveSlots, assignmentsByTrainId, draftsByTrainId, trainById, lpById, alpById } = inputs;
  const ops: PlanSyncOp[] = [];

  for (const [trainId, slot] of effectiveSlots) {
    const train = trainById.get(trainId);
    if (!train) continue;

    const live = assignmentsByTrainId.get(trainId) ?? null;
    const existingDraft = draftsByTrainId.get(trainId) ?? null;

    const liveLp = live?.lp?.id ?? null;
    const liveAlp = live?.alp && live.alp !== 'NOT_REQUIRED' ? live.alp.id : null;
    const liveAlp2 = live?.alp2 && live.alp2 !== 'NOT_REQUIRED' ? live.alp2.id : null;

    // Plan + live agree \u2192 cancel any stale draft, otherwise no-op.
    const matchesLive =
      slot.lpId === liveLp &&
      slot.alpId === liveAlp &&
      slot.alpId2 === liveAlp2;
    if (matchesLive) {
      if (existingDraft) ops.push({ kind: 'remove-draft', trainId, runDate });
      continue;
    }

    // Plan empties everything on a row that has neither live nor draft \u2014 nothing to do.
    if (!live && !existingDraft && !slot.lpId && !slot.alpId && !slot.alpId2) {
      continue;
    }

    // Plan empties a row that has a live assignment \u2192 stage a delete.
    if (live && !slot.lpId && !slot.alpId && !slot.alpId2) {
      ops.push({
        kind: 'upsert',
        draft: {
          kind: 'delete',
          assignmentId: live.assignmentId!,
          trainId: train.id,
          trainNumber: train.number,
          trainName: train.name,
          trainType: train.type,
          runDate,
          departureTime: train.departureTime,
          lpName: live.lp?.name ?? '',
          alpName: live.alp && live.alp !== 'NOT_REQUIRED' ? live.alp.name : null,
          alpName2: live.alp2 && live.alp2 !== 'NOT_REQUIRED' ? live.alp2.name : null,
        },
      });
      continue;
    }

    // Plan empties a row that has only a server draft \u2192 remove the draft.
    if (!live && existingDraft && !slot.lpId && !slot.alpId && !slot.alpId2) {
      ops.push({ kind: 'remove-draft', trainId, runDate });
      continue;
    }

    // Wire shape requires lpId on create/update. An LP-less plan slot
    // never reaches the server — the operator hasn't picked a driver yet,
    // so we leave any pre-existing draft for that train alone and skip.
    if (!slot.lpId) continue;

    const lp = lpById.get(slot.lpId);
    const alp = slot.alpId ? alpById.get(slot.alpId) : null;
    const alp2 = slot.alpId2 ? alpById.get(slot.alpId2) : null;

    if (live) {
      ops.push({
        kind: 'upsert',
        draft: {
          kind: 'update',
          assignmentId: live.assignmentId!,
          trainId: train.id,
          trainNumber: train.number,
          trainName: train.name,
          trainType: train.type,
          runDate,
          departureTime: train.departureTime,
          originalLpName: live.lp?.name ?? '',
          originalAlpName: live.alp && live.alp !== 'NOT_REQUIRED' ? live.alp.name : null,
          originalAlpName2: live.alp2 && live.alp2 !== 'NOT_REQUIRED' ? live.alp2.name : null,
          lpId: slot.lpId,
          lpName: lp?.name ?? '',
          alpId: alp?.id ?? null,
          alpName: alp?.name ?? null,
          alpId2: alp2?.id ?? null,
          alpName2: alp2?.name ?? null,
        },
      });
    } else {
      ops.push({
        kind: 'upsert',
        draft: {
          kind: 'create',
          trainId: train.id,
          trainNumber: train.number,
          trainName: train.name,
          trainType: train.type,
          runDate,
          departureTime: train.departureTime,
          lpId: slot.lpId,
          lpName: lp?.name ?? '',
          alpId: alp?.id ?? null,
          alpName: alp?.name ?? null,
          alpId2: alp2?.id ?? null,
          alpName2: alp2?.name ?? null,
        },
      });
    }
  }

  // NOTE: previously, a second pass cancelled any draft whose train was
  // not in `effectiveSlots`. That assumed every drafted train was also
  // represented in the operator's plan. With Auto-Draft from links, the
  // orchestrator stages drafts directly on the server without touching
  // `plan.slots`, so those drafts would be incorrectly treated as
  // orphans and deleted. The board now models "operator removed this
  // crew" as an empty slot in `plan.slots` (lpId/alpId/alpId2 = null),
  // which the first loop above already turns into a remove-draft op.

  return ops;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Browser-local plan, scoped by run date. Mutations are persisted to
 * localStorage immediately; React state is the source of truth during a
 * session. Returns `null` until the first read settles to avoid a flash
 * of "empty plan" on mount.
 */
export interface UseLinksPlanResult {
  plan: LinksPlan;
  /** True if at least one slot has been touched by the operator. */
  isDirty: boolean;
  /**
   * Stage a slot patch. `null` for a role means "explicitly empty".
   * `undefined` leaves that role unchanged.
   */
  setSlot: (trainId: string, patch: Partial<LinksPlanSlot>) => void;
  /** Drop the slot entry entirely (rotation default will render again). */
  removeSlot: (trainId: string) => void;
  /**
   * Move a crew id off every slot it occupies. `exceptTrainId` keeps
   * the destination slot intact so a DnD move can re-place after vacate.
   */
  vacateCrewFromPlan: (crewId: string, exceptTrainId?: string) => void;
  /** Hide a projected PR pill for this run date. */
  hidePrCrew: (crewId: string) => void;
  /** Restore a previously hidden PR pill. */
  unhidePrCrew: (crewId: string) => void;
  /** Patch a PR row override at `(linkId, positionNumber)`. */
  setPrSlot: (
    linkId: string,
    positionNumber: number,
    patch: Partial<LinksPlanPrSlot>,
  ) => void;
  /** Drop the PR row override entirely. */
  removePrSlot: (linkId: string, positionNumber: number) => void;
  /** Wipe all overrides; rotation defaults render alone. */
  resetPlan: () => void;
}

function newEmptyPlan(runDate: string): LinksPlan {
  return {
    runDate,
    slots: {},
    prSlots: {},
    hiddenPrCrewIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export function useLinksPlan(runDate: string): UseLinksPlanResult {
  const [plan, setPlan] = useState<LinksPlan>(() =>
    loadPlan(runDate) ?? newEmptyPlan(runDate),
  );

  // Re-load whenever the active run date changes.
  useEffect(() => {
    setPlan(loadPlan(runDate) ?? newEmptyPlan(runDate));
  }, [runDate]);

  // Prune stale storage entries once per mount.
  useEffect(() => {
    pruneOldPlans();
  }, []);

  const persist = useCallback((next: LinksPlan) => {
    savePlan(next);
    setPlan(next);
  }, []);

  const setSlot = useCallback(
    (trainId: string, patch: Partial<LinksPlanSlot>) => {
      setPlan((prev) => {
        const next = withSlot(prev, trainId, patch, 'manual');
        savePlan(next);
        return next;
      });
    },
    [],
  );

  const removeSlot = useCallback((trainId: string) => {
    setPlan((prev) => {
      const next = clearSlot(prev, trainId);
      savePlan(next);
      return next;
    });
  }, []);

  const vacateCrewFromPlan = useCallback(
    (crewId: string, exceptTrainId?: string) => {
      setPlan((prev) => {
        const next = vacateCrew(prev, crewId, exceptTrainId);
        savePlan(next);
        return next;
      });
    },
    [],
  );

  const hidePrCrew = useCallback((crewId: string) => {
    setPlan((prev) => {
      const next = withHiddenPrCrew(prev, crewId);
      savePlan(next);
      return next;
    });
  }, []);

  const unhidePrCrew = useCallback((crewId: string) => {
    setPlan((prev) => {
      const next = withoutHiddenPrCrew(prev, crewId);
      savePlan(next);
      return next;
    });
  }, []);

  const setPrSlot = useCallback(
    (linkId: string, positionNumber: number, patch: Partial<LinksPlanPrSlot>) => {
      setPlan((prev) => {
        const next = withPrSlot(prev, linkId, positionNumber, patch);
        savePlan(next);
        return next;
      });
    },
    [],
  );

  const removePrSlot = useCallback((linkId: string, positionNumber: number) => {
    setPlan((prev) => {
      const next = clearPrSlot(prev, linkId, positionNumber);
      savePlan(next);
      return next;
    });
  }, []);

  const resetPlan = useCallback(() => {
    const next = newEmptyPlan(runDate);
    deletePlan(runDate);
    setPlan(next);
  }, [runDate]);

  // Suppress unused warning for `persist` - kept as a future-proof escape hatch.
  void persist;

  return {
    plan,
    isDirty: Object.keys(plan.slots).length > 0,
    setSlot,
    removeSlot,
    vacateCrewFromPlan,
    hidePrCrew,
    unhidePrCrew,
    setPrSlot,
    removePrSlot,
    resetPlan,
  };
}
