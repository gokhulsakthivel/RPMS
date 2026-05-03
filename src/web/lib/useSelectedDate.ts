// `useSelectedDate` — global Context holding the operator's selected date.
//
// design.md §2.1: "the right edge holds the date picker — a single date input
// that drives the 'selected date' for all three tabs. It defaults to tomorrow
// IST. The picker is shared state — switching tabs preserves the selection."
//
// components.md §3 `DatePicker`: "Default value comes from useSelectedDate()
// — initialized to tomorrow IST on first mount, persisted only in memory
// (refresh resets to tomorrow)."
//
// Single writer = `<DatePicker>`. Pages read via `useSelectedDate()`.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { startOfDayIstAsUtc, tomorrowIstIsoDate } from './time';

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface SelectedDateContextValue {
  /** `YYYY-MM-DD` interpreted as the operator's selected day in IST. */
  selectedDate: string;
  /** UTC instant for `00:00 IST` on the selected day — what API calls send. */
  selectedDateIstStartUtc: Date;
  /** Single setter; only `<DatePicker>` should call this. */
  setSelectedDate: (next: string) => void;
}

const SelectedDateContext = createContext<SelectedDateContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SelectedDateProviderProps {
  /** Override the initial date — handy for tests / Storybook. */
  initialDate?: string;
  children: ReactNode;
}

/**
 * Wrap `<App>` in this provider so every page can call `useSelectedDate()`.
 * Memoizes the value so referentially-stable consumers don't churn.
 */
export function SelectedDateProvider({
  initialDate,
  children,
}: SelectedDateProviderProps) {
  const [selectedDate, setSelectedDateState] = useState<string>(
    () => initialDate ?? tomorrowIstIsoDate(),
  );

  const setSelectedDate = useCallback((next: string) => {
    // Trust the DatePicker to feed us valid YYYY-MM-DD strings; if a future
    // caller does something odd, `startOfDayIstAsUtc` will throw and we'll
    // surface that instead of silently corrupting state.
    setSelectedDateState(next);
  }, []);

  const value = useMemo<SelectedDateContextValue>(
    () => ({
      selectedDate,
      selectedDateIstStartUtc: startOfDayIstAsUtc(selectedDate),
      setSelectedDate,
    }),
    [selectedDate, setSelectedDate],
  );

  // We use createElement instead of JSX so this file stays a `.ts` rather
  // than `.tsx` — keeps it next to the rest of the lib/ helpers.
  return createElement(SelectedDateContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSelectedDate(): SelectedDateContextValue {
  const ctx = useContext(SelectedDateContext);
  if (!ctx) {
    // A consumer outside the provider is a bug, not a recoverable state —
    // fail loudly so the offending tree is obvious in the dev console.
    throw new Error(
      'useSelectedDate must be called inside <SelectedDateProvider>',
    );
  }
  return ctx;
}
