//
// Browser-local preferences for the Links board. Persisted under a
// single key in `localStorage`; survives reloads across all run dates.
//
// Currently exposes one pref:
//   - `applyRotationDefaults` — when false, the board renders every
//     outward DUTY slot as empty and includes rotation-projected crew
//     in the crew rail, so the operator assigns purely by drag-and-drop.
//     When true (default), the rotation projection pre-fills slots and
//     occupies those crew (today's behaviour).

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'rpms.linksBoard.applyRotationDefaults';

function readPref(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

function writePref(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Quota or private-mode failure — in-memory copy is still authoritative
    // for the session.
  }
}

export interface LinksBoardPrefs {
  applyRotationDefaults: boolean;
  setApplyRotationDefaults: (value: boolean) => void;
}

export function useLinksBoardPrefs(): LinksBoardPrefs {
  const [applyRotationDefaults, setState] = useState<boolean>(readPref);
  const setApplyRotationDefaults = useCallback((value: boolean) => {
    setState(value);
    writePref(value);
  }, []);
  return { applyRotationDefaults, setApplyRotationDefaults };
}
