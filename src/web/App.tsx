// `App` — top-level route table.
//
// Three primary tabs (design.md §2.1) plus a default redirect to `/trains`.
// The shell component is the layout route; pages render in its `<Outlet />`.
//
// `basename` is set by Vite's `import.meta.env.BASE_URL` so that routes work
// correctly both in local dev (`/`) and on GitHub Pages (`/RPMS/`).

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SelectedDateProvider } from './lib/useSelectedDate';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CrewPage } from './pages/CrewPage';
import { CrewDiaryPage } from './pages/CrewDiaryPage';
import { LeavesPage } from './pages/LeavesPage';
import { LinksPage } from './pages/LinksPage';
import { TrainsPage } from './pages/TrainsPage';

// Strip trailing slash so BrowserRouter doesn't double-up.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

export function App() {
  return (
    <SelectedDateProvider>
      <BrowserRouter basename={basename}>
        <Routes>
          {/* Layout route — renders the shell once, pages slot into <Outlet />. */}
          <Route element={<AppShell />}>
            <Route path="/trains"      element={<TrainsPage />} />
            <Route path="/crew"        element={<CrewPage />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/leaves"      element={<LeavesPage />} />
            <Route path="/links"       element={<LinksPage />} />
            <Route path="/crew-diary"  element={<CrewDiaryPage />} />
            {/* Default + 404 → /trains. The plan calls out the redirect
                explicitly (M6 step 2). */}
            <Route path="/"            element={<Navigate to="/trains" replace />} />
            <Route path="*"            element={<Navigate to="/trains" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SelectedDateProvider>
  );
}
