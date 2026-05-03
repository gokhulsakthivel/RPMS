import { LocoPilot, TrainType } from './types';

/**
 * LP eligibility for a given train type. Pure, deterministic, no I/O.
 *
 * Eligibility is fully data-driven: an LP is eligible for `trainType` iff
 * `trainType` appears in `lp.eligibleTrainTypes`. This list now includes
 * `PASSENGER` and `MAIL_EXPRESS` per-LP — there is no implicit hierarchy.
 *
 * `LpCategory` is retained as a label/role tag (used in the UI and grade
 * projection) but does NOT participate in the eligibility decision. To gate
 * a category transition (e.g. promotion), edit `eligibleTrainTypes` directly.
 *
 * See HLD §4.2.
 */
export function isLpEligible(lp: LocoPilot, trainType: TrainType): boolean {
  return lp.eligibleTrainTypes.includes(trainType);
}
