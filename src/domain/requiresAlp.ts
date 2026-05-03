import { TrainType } from './types';

/**
 * Whether a train type requires an ALP. Returns false ONLY for MEMU and DEMU.
 *
 * Source of truth: HLD §4.1 / LLD §3.1.
 */
export function requiresAlp(trainType: TrainType): boolean {
  return trainType !== TrainType.MEMU && trainType !== TrainType.DEMU;
}
