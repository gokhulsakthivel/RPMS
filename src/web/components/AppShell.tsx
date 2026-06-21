// `AppShell` — fixed-chrome layout used by every page (design.md §2.1).
//
// Structure:
//   ┌─────────────────────────── 48px header ──────────────────────────┐
//   │ RPMS · Railway People Management            v0.1.0  [DatePicker] │
//   ├──────────────── summary cards strip (4 StatCards) ───────────────┤
//   ├──────────────────────────── 44px tabs ───────────────────────────┤
//   │  [ Trains ]  [ Crew ]  [ Assignments ]                           │
//   ├──────────────────────────── page area ───────────────────────────┤
//   │ <Outlet />                                                       │
//   └──────────────────────────────────────────────────────────────────┘

import { Link, Outlet, useMatch } from 'react-router-dom';
import { SummaryCards } from './chrome/SummaryCards';
import { ToastProvider } from './feedback/Toast';
import { useSelectedDate } from '../lib/useSelectedDate';
import { DatePicker } from './DatePicker';

const APP_VERSION = '0.1.0';

const TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/trains',      label: 'Trains' },
  { to: '/crew',        label: 'Crew' },
  { to: '/assignments', label: 'Assignments' },
  { to: '/leaves',      label: 'Leaves' },
  { to: '/links',       label: 'Links' },
  { to: '/crew-diary',  label: 'Crew Diary' },
];

/**
 * One pill in the tab bar. Pulled out so we can keep `aria-selected`
 * directly on the `role="tab"` anchor (per components.md §3 `TabBar`).
 *
 * `useMatch` returns `null` when the current URL doesn't match, so we
 * coerce to a boolean for the aria attribute and the CSS selector.
 */
function TabLink({ to, label }: { to: string; label: string }) {
  // `*` so deep links like /trains/123 still highlight the Trains tab.
  const isActive = !!useMatch({ path: `${to}/*`, end: false });
  return (
    <Link
      to={to}
      role="tab"
      aria-selected={isActive}
      className="tab-bar__link"
    >
      {label}
    </Link>
  );
}

export function AppShell() {
  const { selectedDate, setSelectedDate } = useSelectedDate();

  return (
    <ToastProvider>
      <div className="app-root">
        {/* ----- Header (48px sticky bar) ----- */}
        <header className="app-header">
          <div className="app-header__brand">
            <span className="app-header__title">RPMS</span>
            <span className="app-header__subtitle">
              Railway People Management
            </span>
          </div>
          <div className="app-header__right">
            <span
              className="app-header__version"
              aria-label={`version ${APP_VERSION}`}
            >
              v{APP_VERSION}
            </span>
            <DatePicker value={selectedDate} onChange={setSelectedDate} />
          </div>
        </header>

        {/* ----- Summary strip (sits above the tab bar per design.md §2.1) ----- */}
        <SummaryCards />

        {/* ----- Tab bar (44px outlined-pill nav) ----- */}
        <nav className="tab-bar" role="tablist" aria-label="Primary">
          {TABS.map((tab) => (
            <TabLink key={tab.to} to={tab.to} label={tab.label} />
          ))}
        </nav>

        {/* ----- Page area (role="tabpanel" per components.md §3) ----- */}
        <main className="app-page" role="tabpanel">
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
