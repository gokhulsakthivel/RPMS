//
// Browser-local preferences for the Links board. Persisted under
// per-pref keys in `localStorage`; survives reloads across all run dates.
//
// Currently exposes:
//   - `applyRotationDefaults` — when false (default), the board renders
//     every outward DUTY slot as empty and includes rotation-projected
//     crew in the crew rail, so the operator assigns purely by
//     drag-and-drop. When true, the rotation projection pre-fills slots
//     and occupies those crew.
//   - `crewRailCollapsed` — when true, the right-side crew rail shrinks
//     to a compact strip showing only bucket pills + counts; the board
//     reclaims the freed horizontal space.

import { useCallback, useState } from 'react';

const APPLY_DEFAULTS_KEY = 'rpms.linksBoard.applyRotationDefaults';
const RAIL_COLLAPSED_KEY = 'rpms.linksBoard.crewRailCollapsed';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-mode failure — in-memory copy is still authoritative
    // for the session.
  }
}

export interface LinksBoardPrefs {
  applyRotationDefaults: boolean;
  setApplyRotationDefaults: (value: boolean) => void;
  crewRailCollapsed: boolean;
  setCrewRailCollapsed: (value: boolean) => void;
}

export function useLinksBoardPrefs(): LinksBoardPrefs {
  const [applyRotationDefaults, setApply] = useState<boolean>(() =>
    readBool(APPLY_DEFAULTS_KEY, false),
  );
  const [crewRailCollapsed, setCollapsed] = useState<boolean>(() =>
    readBool(RAIL_COLLAPSED_KEY, false),
  );
  const setApplyRotationDefaults = useCallback((value: boolean) => {
    setApply(value);
    writeBool(APPLY_DEFAULTS_KEY, value);
  }, []);
  const setCrewRailCollapsed = useCallback((value: boolean) => {
    setCollapsed(value);
    writeBool(RAIL_COLLAPSED_KEY, value);
  }, []);
  return {
    applyRotationDefaults,
    setApplyRotationDefaults,
    crewRailCollapsed,
    setCrewRailCollapsed,
  };
}
