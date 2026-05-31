import { TrainType } from './types';

/**
 * Number of ALPs a train type requires.
 *   0 — MEMU / DEMU (no ALP slot at all).
 *   2 — Amrit Bharat (two ALPs ride every run).
 *   1 — everything else.
 *
 * Source of truth: HLD §4.1.
 */
export function requiredAlpCount(trainType: TrainType): 0 | 1 | 2 {
  if (trainType === TrainType.MEMU || trainType === TrainType.DEMU) return 0;
  if (trainType === TrainType.AMRIT_BHARAT) return 2;
  return 1;
}

/**
 * Whether a train type requires at least one ALP. Returns false ONLY for
 * MEMU and DEMU. Kept as a thin wrapper over `requiredAlpCount` so the rest
 * of the code that doesn't care about the exact count keeps reading well.
 *
 * Source of truth: HLD §4.1 / LLD §3.1.
 */
export function requiresAlp(trainType: TrainType): boolean {
  return requiredAlpCount(trainType) > 0;
}
