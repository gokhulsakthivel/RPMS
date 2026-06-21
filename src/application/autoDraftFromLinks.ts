// `autoDraftFromLinks` — Phase 3 of the Links feature.
//
// For a given run date, propose a draft assignment for every train that
// runs on that date, sourced from the active link memberships:
//
//   1. List trains scheduled to run on `runDate`.
//   2. Skip trains that already have an active assignment for `(trainId, runDate)`.
//   3. Skip trains that already have a draft staged for `(trainId, runDate)`.
//   4. For each remaining train, search every active link's positions for
//      a DUTY segment whose `trainNumber === train.number`.
//   5. From the matching link's memberships, find the member whose resolved
//      position on `runDate` equals the matching positionNumber.
//   6. Pick one LP membership (from an LP-link). If the train requires an
//      ALP, pick one ALP membership from an ALP-link covering the same
//      train. (Same selection rule; ALPs come from `crewRole: ALP` links.)
//   7. Re-validate the candidates with the same domain predicates
//      `assignCrew` uses — eligibility, leave, window overlap. Rest is
//      currently not gated by `assignCrew` (see comment in §LP step 2).
//      The HLD §4.11 same-position rest exception therefore has no effect
//      on this orchestrator today, but the design accommodates it once
//      rest is re-introduced (set `skipRestForSamePosition: true`).
//
// This orchestrator is PURE relative to side effects — it returns
// proposals; the API layer is responsible for upserting them into the
// draft cart. That keeps Auto-Draft testable without a draft repo.

import { findWindowConflict } from '../domain/hasWindowConflict';
import { isAlpEligible } from '../domain/isAlpEligible';
import { isLpEligible } from '../domain/isLpEligible';
import { findCoveringLeave } from '../domain/isOnLeave';
import { findOutwardPair, outwardRunDate } from '../domain/linkPairing';
import { positionOnDate } from '../domain/linkSchedule';
import {
  AssignmentDraftRepo,
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LeaveRepo,
  LinkMembershipRepo,
  LinkRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { materializeRun, trainRunsOn } from '../domain/runSchedule';
import { requiredAlpCount } from '../domain/requiresAlp';
import {
  LinkPositionKind,
  type Assignment,
  type AssistantLocoPilot,
  type Link,
  type LinkMembership,
  type LinkPosition,
  type LocoPilot,
  type Train,
} from '../domain/types';

type DutyPosition = Extract<LinkPosition, { kind: LinkPositionKind.DUTY }>;

export interface AutoDraftDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
  drafts: AssignmentDraftRepo;
  leaves: LeaveRepo;
  links: LinkRepo;
  linkMemberships: LinkMembershipRepo;
}

/** Reason a train was not auto-drafted. Machine-readable so the UI can group. */
export type AutoDraftSkipReason =
  | { code: 'ALREADY_ASSIGNED' }
  | { code: 'ALREADY_DRAFTED' }
  | { code: 'NO_LINK_FOR_TRAIN' }
  | { code: 'NO_LP_MEMBER_AT_POSITION' }
  | { code: 'NO_ALP_MEMBER_AT_POSITION' }
  | { code: 'LP_NOT_ELIGIBLE'; lpId: string }
  | { code: 'LP_ON_LEAVE'; lpId: string }
  | { code: 'LP_WINDOW_CONFLICT'; lpId: string; conflictingAssignmentId: string }
  | { code: 'ALP_NOT_ELIGIBLE'; alpId: string }
  | { code: 'ALP_ON_LEAVE'; alpId: string }
  | { code: 'ALP_WINDOW_CONFLICT'; alpId: string; conflictingAssignmentId: string }
  | { code: 'SECOND_ALP_NOT_SUPPORTED' };

export interface AutoDraftProposal {
  train: Train;
  runDate: string;
  departureTime: Date;
  lp: LocoPilot;
  alp?: AssistantLocoPilot;
  /** For UI explainability: which link sourced each pick. */
  lpLinkName: string;
  alpLinkName?: string;
  positionNumber: number;
}

export interface AutoDraftSkipped {
  trainId: string;
  trainNumber: string;
  reason: AutoDraftSkipReason;
}

export interface AutoDraftResult {
  proposals: AutoDraftProposal[];
  skipped: AutoDraftSkipped[];
}

export interface AutoDraftInput {
  /** IST `YYYY-MM-DD`. */
  runDate: string;
  /**
   * Set of trainIds that already have a draft staged for this date. The
   * orchestrator skips these to avoid clobbering operator-staged picks.
   */
  existingDraftTrainIds: ReadonlySet<string>;
}

export async function autoDraftFromLinks(
  deps: AutoDraftDeps,
  input: AutoDraftInput,
): Promise<AutoDraftResult> {
  const { runDate, existingDraftTrainIds } = input;

  const [allTrains, allLinks, allMemberships, allLps, allAlps] =
    await Promise.all([
      deps.trains.list(),
      deps.links.list(),
      deps.linkMemberships.list(),
      deps.lps.list(),
      deps.alps.list(),
    ]);

  const lpsById = new Map(allLps.map((c) => [c.id, c] as const));
  const alpsById = new Map(allAlps.map((c) => [c.id, c] as const));
  const activeLpIds: ReadonlySet<string> = new Set(lpsById.keys());
  const activeAlpIds: ReadonlySet<string> = new Set(alpsById.keys());
  const linksById = new Map(allLinks.map((l) => [l.id, l] as const));
  const trainsById = new Map(allTrains.map((t) => [t.id, t] as const));

  // Seed a per-crew "soft booking" map with windows from existing drafts
  // (any kind that names a crew) so the picker can't propose the same LP
  // twice when one is already staged. Each accepted proposal in the loop
  // below appends to this map so within-batch collisions are also caught.
  const bookedByCrew = new Map<string, Assignment[]>();
  const draftsForDate = await deps.drafts.list({ runDate });
  for (const d of draftsForDate) {
    const train = trainsById.get(d.trainId);
    if (!train) continue;
    const { departureTimeUtc, signOffTimeUtc } = materializeRun(train, d.runDate);
    const synth = (crewId: string) => {
      const list = bookedByCrew.get(crewId) ?? [];
      list.push(synthBooking(`draft:${d.id}`, departureTimeUtc, signOffTimeUtc));
      bookedByCrew.set(crewId, list);
    };
    if (d.kind !== 'delete' && d.lpId) synth(d.lpId);
    if (d.kind !== 'delete' && d.alpId) synth(d.alpId);
    if (d.kind !== 'delete' && d.alpId2) synth(d.alpId2);
  }

  // Group memberships by linkId so position-resolution stays O(members in link).
  const membersByLink = new Map<string, LinkMembership[]>();
  for (const m of allMemberships) {
    const bucket = membersByLink.get(m.linkId);
    if (bucket) bucket.push(m);
    else membersByLink.set(m.linkId, [m]);
  }

  // Index every DUTY segment by trainNumber across every link, capturing
  // the source position so we know which (link, positionNumber) covers a
  // given train. A train number can theoretically appear in multiple links
  // (e.g. an LP link AND an ALP link); we keep all matches.
  const coverageByTrainNumber = new Map<string, TrainCoverage[]>();
  for (const link of allLinks) {
    for (const pos of link.positions) {
      if (pos.kind !== LinkPositionKind.DUTY) continue;
      for (const seg of pos.segments) {
        const list = coverageByTrainNumber.get(seg.trainNumber);
        const entry: TrainCoverage = { link, position: pos };
        if (list) list.push(entry);
        else coverageByTrainNumber.set(seg.trainNumber, [entry]);
      }
    }
  }

  const proposals: AutoDraftProposal[] = [];
  const skipped: AutoDraftSkipped[] = [];

  const trainsToday = allTrains.filter((t) => trainRunsOn(t, runDate));

  for (const train of trainsToday) {
    if (existingDraftTrainIds.has(train.id)) {
      skipped.push(skip(train, { code: 'ALREADY_DRAFTED' }));
      continue;
    }

    const existingByTrain = await deps.assignments.listByTrain(train.id);
    const activeForRun = existingByTrain.find(
      (a) => a.runDate === runDate && !a.archivedAt,
    );
    if (activeForRun) {
      skipped.push(skip(train, { code: 'ALREADY_ASSIGNED' }));
      continue;
    }

    const coverages = coverageByTrainNumber.get(train.number) ?? [];
    if (coverages.length === 0) {
      skipped.push(skip(train, { code: 'NO_LINK_FOR_TRAIN' }));
      continue;
    }

    // Two ALPs (Amrit Bharat) — not yet supported by Auto-Draft. Operators
    // still drive that case manually. Keeping the skip code so the SPA can
    // surface a precise reason.
    const alpCount = requiredAlpCount(train.type);
    if (alpCount === 2) {
      skipped.push(skip(train, { code: 'SECOND_ALP_NOT_SUPPORTED' }));
      continue;
    }
    const needsAlp = alpCount === 1;

    const { departureTimeUtc, signOffTimeUtc } = materializeRun(train, runDate);

    // Each train number can appear in multiple positions (e.g. inward
    // leg at pos N, outward leg at pos N+1). The OUTWARD segment whose
    // route matches the train's published `onward` direction is the
    // crew actually driving the published departure — prefer that
    // coverage. Other coverages fall through as fallbacks.
    const orderedCoverages = orderCoveragesForTrain(coverages, train);

    // -- Try the inward→outward chain first. If this train's coverage on
    //    an LP-link is an INWARD segment, prefer the crew already
    //    committed to the paired OUTWARD train (same-day or prev-day per
    //    pair kind). Falls through to the rotation pick if no committed
    //    outward assignment exists.
    const chained = await findChainedPickFromOutward(
      train,
      orderedCoverages,
      runDate,
      deps.assignments,
      allTrains,
      lpsById,
      alpsById,
      needsAlp,
    );

    // -- Pick LP — chained pick wins; else first link-rotation match.
    const lpPick = chained
      ? null
      : pickFirstMemberForRole(
          orderedCoverages,
          'LP',
          membersByLink,
          runDate,
          activeLpIds,
        );
    if (!lpPick && !chained) {
      skipped.push(skip(train, { code: 'NO_LP_MEMBER_AT_POSITION' }));
      continue;
    }
    const lp = chained ? chained.lp : lpsById.get(lpPick!.membership.crewId);
    if (!lp) {
      // Crew archived/missing — treat as no candidate. Operators clean up
      // stale memberships from the Links page.
      skipped.push(skip(train, { code: 'NO_LP_MEMBER_AT_POSITION' }));
      continue;
    }

    // -- Validate LP.
    if (!isLpEligible(lp, train.type)) {
      skipped.push(skip(train, { code: 'LP_NOT_ELIGIBLE', lpId: lp.id }));
      continue;
    }
    const lpLeaves = await deps.leaves.listByCrew(lp.id);
    if (findCoveringLeave(lpLeaves, runDate)) {
      skipped.push(skip(train, { code: 'LP_ON_LEAVE', lpId: lp.id }));
      continue;
    }
    const lpConflict = findWindowConflict(
      { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
      [
        ...(await deps.assignments.listByCrew(lp.id)),
        ...(bookedByCrew.get(lp.id) ?? []),
      ],
    );
    if (lpConflict) {
      skipped.push(
        skip(train, {
          code: 'LP_WINDOW_CONFLICT',
          lpId: lp.id,
          conflictingAssignmentId: lpConflict.id,
        }),
      );
      continue;
    }

    // -- ALP (only when required).
    let alp: AssistantLocoPilot | undefined;
    let alpLinkName: string | undefined;
    if (needsAlp) {
      // Chained path: adopt the outward's ALP if present.
      const candidate: AssistantLocoPilot | undefined = chained?.alp
        ?? await (async () => {
          const alpPick = pickFirstMemberForRole(
            orderedCoverages,
            'ALP',
            membersByLink,
            runDate,
            activeAlpIds,
          );
          if (!alpPick) return undefined;
          const c = alpsById.get(alpPick.membership.crewId);
          if (!c) return undefined;
          alpLinkName = alpPick.link.name;
          return c;
        })();
      if (!candidate) {
        skipped.push(skip(train, { code: 'NO_ALP_MEMBER_AT_POSITION' }));
        continue;
      }
      if (chained?.alp) {
        alpLinkName = chained.alpLinkName ?? chained.lpLinkName;
      }
      if (!isAlpEligible(candidate, train.type)) {
        skipped.push(
          skip(train, { code: 'ALP_NOT_ELIGIBLE', alpId: candidate.id }),
        );
        continue;
      }
      const alpLeaves = await deps.leaves.listByCrew(candidate.id);
      if (findCoveringLeave(alpLeaves, runDate)) {
        skipped.push(
          skip(train, { code: 'ALP_ON_LEAVE', alpId: candidate.id }),
        );
        continue;
      }
      const alpConflict = findWindowConflict(
        { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
        [
          ...(await deps.assignments.listByCrew(candidate.id)),
          ...(bookedByCrew.get(candidate.id) ?? []),
        ],
      );
      if (alpConflict) {
        skipped.push(
          skip(train, {
            code: 'ALP_WINDOW_CONFLICT',
            alpId: candidate.id,
            conflictingAssignmentId: alpConflict.id,
          }),
        );
        continue;
      }
      alp = candidate;
    }

    const proposal: AutoDraftProposal = {
      train,
      runDate,
      departureTime: departureTimeUtc,
      lp,
      lpLinkName: chained ? chained.lpLinkName : lpPick!.link.name,
      positionNumber: chained
        ? chained.positionNumber
        : lpPick!.position.positionNumber,
    };
    if (alp) proposal.alp = alp;
    if (alpLinkName) proposal.alpLinkName = alpLinkName;
    proposals.push(proposal);

    // Record the booking so subsequent trains in this same Auto-Draft run
    // see this LP / ALP as busy and don't get double-staged.
    const tag = `proposal:${train.id}`;
    const lpList = bookedByCrew.get(lp.id) ?? [];
    lpList.push(synthBooking(tag, departureTimeUtc, signOffTimeUtc));
    bookedByCrew.set(lp.id, lpList);
    if (alp) {
      const alpList = bookedByCrew.get(alp.id) ?? [];
      alpList.push(synthBooking(tag, departureTimeUtc, signOffTimeUtc));
      bookedByCrew.set(alp.id, alpList);
    }
  }

  // Suppress unused-import lint while keeping the dep in place — `linksById`
  // is reserved for future use (e.g. surfacing archived-link reasons).
  void linksById;
  return { proposals, skipped };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface TrainCoverage {
  link: Link;
  position: DutyPosition;
}

interface MemberPick {
  link: Link;
  position: DutyPosition;
  membership: LinkMembership;
}

/**
 * Walk the coverages for a train, filter to the requested role, and return
 * the first one whose membership roster contains a crew member resolving
 * to the matching position on `runDate`. Memberships whose crew is not
 * in `activeCrewIds` (archived or missing from the roster) are skipped so
 * a single dangling membership at one position doesn't block the train
 * when another coverage has a valid active member.
 */
function pickFirstMemberForRole(
  coverages: ReadonlyArray<TrainCoverage>,
  role: 'LP' | 'ALP',
  membersByLink: ReadonlyMap<string, ReadonlyArray<LinkMembership>>,
  runDate: string,
  activeCrewIds: ReadonlySet<string>,
): MemberPick | null {
  for (const c of coverages) {
    if (c.link.crewRole !== role) continue;
    const members = membersByLink.get(c.link.id) ?? [];
    for (const m of members) {
      if (!activeCrewIds.has(m.crewId)) continue;
      const resolved = positionOnDate(c.link, m, runDate);
      if (resolved === c.position.positionNumber) {
        return { link: c.link, position: c.position, membership: m };
      }
    }
  }
  return null;
}

/**
 * Sort coverages so the position whose segment matches the train's
 * published outward route (onward from→to) comes first, then any other
 * outward segment for this train, then inward segments. Stable across
 * equal classes.
 */
function orderCoveragesForTrain(
  coverages: ReadonlyArray<TrainCoverage>,
  train: Train,
): TrainCoverage[] {
  const rank = (c: TrainCoverage): number => {
    const seg = c.position.segments.find((s) => s.trainNumber === train.number);
    if (!seg) return 3;
    if (
      seg.direction === 'outward'
      && seg.fromStation === train.onwardFromStation
      && seg.toStation === train.onwardToStation
    ) {
      return 0;
    }
    if (seg.direction === 'outward') return 1;
    return 2;
  };
  return [...coverages]
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.c);
}

function skip(train: Train, reason: AutoDraftSkipReason): AutoDraftSkipped {
  return { trainId: train.id, trainNumber: train.number, reason };
}

// Synthetic `Assignment`-shaped row used only as input to
// `findWindowConflict`. The predicate reads `id`, `departureTime`, and
// `signOffTime` — everything else is filler.
function synthBooking(
  id: string,
  departureTime: Date,
  signOffTime: Date,
): Assignment {
  return {
    id,
    trainId: '',
    runDate: '',
    departureTime,
    signOffTime,
    lpId: '',
    alpId: null,
    alpId2: null,
    createdAt: new Date(0),
    archivedAt: null,
  } as unknown as Assignment;
}

/** Resolved chained pick (LP + optional ALP) sourced from the paired
 *  outward's already-committed assignment. */
interface ChainedPick {
  lp: LocoPilot;
  alp?: AssistantLocoPilot;
  lpLinkName: string;
  alpLinkName?: string;
  positionNumber: number;
}

/**
 * If the train sits at an INWARD segment on any LP-link, walk to the
 * paired OUTWARD segment, look up the active assignment for
 * `(outwardTrain, outwardRunDate)`, and adopt its crew. Returns
 * `undefined` if no chain is available.
 *
 * The chain only fires when:
 *   - the train's coverage on at least one LP-link is `direction === 'inward'`,
 *   - the pair walk finds an OUTWARD segment in this or the previous position,
 *   - the outward train exists in the trains roster,
 *   - the outward train has an active (non-archived) assignment for the
 *     correct run date (same-day or prev-day per pair kind),
 *   - and the LP from that assignment is still in the LP roster.
 *
 * ALP adoption is best-effort: if the outward had one and we need one, we
 * use it; otherwise we fall back to the rotation pick in the caller.
 */
async function findChainedPickFromOutward(
  train: Train,
  coverages: ReadonlyArray<TrainCoverage>,
  runDate: string,
  assignments: AssignmentRepo,
  allTrains: ReadonlyArray<Train>,
  lpsById: ReadonlyMap<string, LocoPilot>,
  alpsById: ReadonlyMap<string, AssistantLocoPilot>,
  needsAlp: boolean,
): Promise<ChainedPick | undefined> {
  for (const cov of coverages) {
    if (cov.link.crewRole !== 'LP') continue;
    const segIdx = cov.position.segments.findIndex(
      (s) => s.trainNumber === train.number,
    );
    if (segIdx < 0) continue;
    const seg = cov.position.segments[segIdx];
    if (!seg || seg.direction !== 'inward') continue;
    const pair = findOutwardPair(cov.link, cov.position.positionNumber, segIdx);
    if (!pair) continue;
    const outDate = outwardRunDate(runDate, pair.pairKind);
    const outwardTrain = allTrains.find(
      (t) => t.number === pair.outward.trainNumber,
    );
    if (!outwardTrain) continue;
    const outwardAssignments = await assignments.listByTrain(outwardTrain.id);
    const active = outwardAssignments.find(
      (a) => a.runDate === outDate && !a.archivedAt,
    );
    if (!active) continue;
    const lp = lpsById.get(active.lpId);
    if (!lp) continue;
    const chained: ChainedPick = {
      lp,
      lpLinkName: `${cov.link.name} (↩ ${pair.outward.trainNumber} · ${outDate})`,
      positionNumber: cov.position.positionNumber,
    };
    if (needsAlp && active.alpId) {
      const adoptedAlp = alpsById.get(active.alpId);
      if (adoptedAlp) {
        chained.alp = adoptedAlp;
        chained.alpLinkName = chained.lpLinkName;
      }
    }
    return chained;
  }
  return undefined;
}
