// React 18 entry point — mounts <App /> into #root.
//
// `StrictMode` is on in development so effect cleanup bugs surface early
// (every page's fetch effect already has a cancellation flag for this).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  // index.html ships with `<div id="root"></div>` — if this throws, somebody
  // edited the template and the SPA can't boot.
  throw new Error('main.tsx: missing #root container in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
