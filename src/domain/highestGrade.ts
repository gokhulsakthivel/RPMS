import {
  AssistantLocoPilot,
  LocoPilot,
  TrainType,
} from './types';

/**
 * Grade ordering for the Crew table's `<CrewGradeBadge>` projection.
 * Source of truth: design.md §9.2 — "Always show the highest grade".
 *
 *   MEMU < DEMU < PASSENGER < MAIL_EXPRESS < VANDE_BHARAT < AMRIT_BHARAT
 *
 * Higher index = higher rank. Lookup is O(1).
 */
const GRADE_RANK: Record<TrainType, number> = {
  [TrainType.MEMU]:         0,
  [TrainType.DEMU]:         1,
  [TrainType.PASSENGER]:    2,
  [TrainType.MAIL_EXPRESS]: 3,
  [TrainType.VANDE_BHARAT]: 4,
  [TrainType.AMRIT_BHARAT]: 5,
};

/**
 * The complete set of train types this LP can drive. Eligibility is now
 * fully data-driven (see `isLpEligible`): the LP's `eligibleTrainTypes`
 * list IS the drivable set — including `PASSENGER` / `MAIL_EXPRESS`.
 *
 * Returns a defensive copy so callers can mutate freely.
 */
export function lpDrivableTypes(lp: LocoPilot): TrainType[] {
  return [...lp.eligibleTrainTypes];
}

/**
 * The complete set of train types this ALP can serve. ALPs hold no hierarchy;
 * the certifications on `eligibleTrainTypes` are exhaustive.
 *
 * MEMU/DEMU must never appear here (CSV loader enforces it); we strip them
 * defensively in case of corrupted data.
 */
export function alpDrivableTypes(alp: AssistantLocoPilot): TrainType[] {
  return alp.eligibleTrainTypes.filter(
    (t) => t !== TrainType.MEMU && t !== TrainType.DEMU,
  );
}

/**
 * Highest-rank train type from a set, by GRADE_RANK. Returns undefined for an
 * empty set (i.e., a brand-new ALP with no certifications).
 */
export function highestGrade(types: TrainType[]): TrainType | undefined {
  if (types.length === 0) return undefined;
  let best = types[0]!;
  for (const t of types) {
    if (GRADE_RANK[t] > GRADE_RANK[best]) best = t;
  }
  return best;
}

/**
 * Whether the set covers every TrainType. Drives the "All types" pseudo-badge
 * in design.md §9.2 — only renders when the LP can genuinely cover all six
 * types. Unreachable for ALPs (MEMU/DEMU are forbidden by the schema), so the
 * caller passes `allowAllTypes=false` for ALP rows.
 */
export function coversAllTrainTypes(types: TrainType[]): boolean {
  if (types.length < 6) return false;
  const set = new Set(types);
  return (
    set.has(TrainType.PASSENGER) &&
    set.has(TrainType.MEMU) &&
    set.has(TrainType.DEMU) &&
    set.has(TrainType.MAIL_EXPRESS) &&
    set.has(TrainType.VANDE_BHARAT) &&
    set.has(TrainType.AMRIT_BHARAT)
  );
}
