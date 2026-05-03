// `Toast` + `useToast` — bottom-right ephemeral notification
// (components.md §5 / design.md §7).
//
// Behaviour:
//   - Auto-dismisses after 3000ms (success) or 4500ms (error). Single source.
//   - Stacks vertically (newest at the bottom), max 3 visible.
//   - Uses a portal to keep it above modals.
//   - Provider lives at the top of the tree (added in M7c when wired in).
//
// API is intentionally tiny:
//
//   const toast = useToast();
//   toast.success('Train created');
//   toast.error('Couldn\'t archive: NETWORK_ERROR');

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Types & context
// ---------------------------------------------------------------------------

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** ms until auto-dismiss. */
  ttl: number;
}

interface ToastApi {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_TTL: Record<ToastTone, number> = {
  success: 3000,
  error: 4500,
  info: 3000,
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((curr) => curr.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      idRef.current += 1;
      const id = idRef.current;
      const ttl = DEFAULT_TTL[tone];
      setItems((curr) => {
        // Cap at 3 — drop oldest first so the latest action is always visible.
        const next = [...curr, { id, tone, message, ttl }];
        return next.length > 3 ? next.slice(next.length - 3) : next;
      });
      // Schedule dismiss outside React state to avoid stale-closure pitfalls.
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (msg) => push('success', msg),
      error:   (msg) => push('error', msg),
      info:    (msg) => push('info', msg),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be called inside <ToastProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Viewport (portal-mounted bottom-right stack)
// ---------------------------------------------------------------------------

interface ToastViewportProps {
  items: ReadonlyArray<ToastItem>;
  onDismiss: (id: number) => void;
}

function ToastViewport({ items, onDismiss }: ToastViewportProps) {
  // SSR safety: only mount the portal in the browser.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.body);
  }, []);
  if (!target) return null;
  return createPortal(
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.tone}`}
          role={t.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="toast__msg">{t.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    target,
  );
}
