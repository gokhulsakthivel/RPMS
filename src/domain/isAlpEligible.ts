import { AssistantLocoPilot, TrainType } from './types';

/**
 * ALP eligibility for a given train type. Pure, deterministic, no I/O.
 *
 * ALPs are NEVER assigned to MEMU or DEMU. The CSV loader rejects rows that
 * include those types in `eligibleTrainTypes`, but we still defend in depth
 * here: even if data is somehow corrupted, this function refuses MEMU/DEMU.
 */
export function isAlpEligible(alp: AssistantLocoPilot, trainType: TrainType): boolean {
  if (trainType === TrainType.MEMU || trainType === TrainType.DEMU) {
    return false;
  }
  return alp.eligibleTrainTypes.includes(trainType);
}
