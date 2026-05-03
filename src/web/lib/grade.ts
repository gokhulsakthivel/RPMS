// `grade.ts` — UI-side hierarchy ordering for `TrainType`.
//
// The Grade Badge value in the Crew table (design.md §9.2) is computed
// **server-side** and arrives in `CrewRow.grade`. The UI never re-derives
// it from `eligibleTrainTypes` — that's the contract.
//
// This module exists for the few places the UI needs to order or display
// a list of `TrainType`s consistently:
//
//  1. The "Eligible for" cell (`CrewEligibleForCell`) sorts the short
//     labels by hierarchy ordering (MEMU first, AB last) per design.md §9.2.
//  2. The "All types" check tests whether the effective set ⊇ all 6 types.
//
// Keep the ordering and short-form labels here in sync with design.md §9.2.

import { TrainType } from '../../domain/types';

/**
 * Hierarchy ordering, lowest → highest. design.md §9.2:
 *   MEMU < DEMU < PASSENGER < MAIL_EXPRESS < VANDE_BHARAT < AMRIT_BHARAT
 *
 * Use `HIERARCHY_RANK[type]` to compare. Higher number = higher rank.
 */
export const HIERARCHY_RANK: Record<TrainType, number> = {
  [TrainType.MEMU]:         0,
  [TrainType.DEMU]:         1,
  [TrainType.PASSENGER]:    2,
  [TrainType.MAIL_EXPRESS]: 3,
  [TrainType.VANDE_BHARAT]: 4,
  [TrainType.AMRIT_BHARAT]: 5,
};

/** Sorts a list of `TrainType` ascending by hierarchy. Pure, stable. */
export function sortByHierarchy(types: ReadonlyArray<TrainType>): TrainType[] {
  return [...types].sort((a, b) => HIERARCHY_RANK[a] - HIERARCHY_RANK[b]);
}

/**
 * Short-form label used in the "Eligible for" cell (design.md §9.2 table)
 * and the AssignCrewModal mini-badge.
 */
export function shortFormLabel(type: TrainType): string {
  switch (type) {
    case TrainType.PASSENGER:    return 'Passenger';
    case TrainType.MAIL_EXPRESS: return 'Mail/Express';
    case TrainType.MEMU:         return 'MEMU';
    case TrainType.DEMU:         return 'DEMU';
    case TrainType.VANDE_BHARAT: return 'VB';
    case TrainType.AMRIT_BHARAT: return 'AB';
  }
}

/**
 * Long-form label used in train type badges, modal headers, and form
 * dropdowns. Mirrors the user-facing wording from design.md §9.1 / §9.3.
 */
export function longFormLabel(type: TrainType): string {
  switch (type) {
    case TrainType.PASSENGER:    return 'Passenger';
    case TrainType.MAIL_EXPRESS: return 'Mail/Express';
    case TrainType.MEMU:         return 'MEMU';
    case TrainType.DEMU:         return 'DEMU';
    case TrainType.VANDE_BHARAT: return 'Vande Bharat';
    case TrainType.AMRIT_BHARAT: return 'Amrit Bharat';
  }
}

/**
 * The CSS-token slug used to look up the train-type badge / chip color
 * pair in `styles.css` (design.md §3.5). For example, MAIL_EXPRESS →
 * `--accent-mail-express-bg` / `--accent-mail-express-text`.
 */
export function tokenSlug(type: TrainType): string {
  switch (type) {
    case TrainType.PASSENGER:    return 'passenger';
    case TrainType.MAIL_EXPRESS: return 'mail-express';
    case TrainType.MEMU:         return 'memu';
    case TrainType.DEMU:         return 'demu';
    case TrainType.VANDE_BHARAT: return 'vande-bharat';
    case TrainType.AMRIT_BHARAT: return 'amrit-bharat';
  }
}

/** All `TrainType` values, ordered by hierarchy (low → high). */
export const ALL_TRAIN_TYPES_BY_HIERARCHY: readonly TrainType[] = sortByHierarchy(
  Object.values(TrainType),
);
