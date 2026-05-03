// `App` — top-level route table.
//
// Three primary tabs (design.md §2.1) plus a default redirect to `/trains`.
// The shell component is the layout route; pages render in its `<Outlet />`.

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { SelectedDateProvider } from './lib/useSelectedDate';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CrewPage } from './pages/CrewPage';
import { LeavesPage } from './pages/LeavesPage';
import { TrainsPage } from './pages/TrainsPage';

export function App() {
  return (
    <SelectedDateProvider>
      <BrowserRouter>
        <Routes>
          {/* Layout route — renders the shell once, pages slot into <Outlet />. */}
          <Route element={<AppShell />}>
            <Route path="/trains"      element={<TrainsPage />} />
            <Route path="/crew"        element={<CrewPage />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/leaves"      element={<LeavesPage />} />
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
