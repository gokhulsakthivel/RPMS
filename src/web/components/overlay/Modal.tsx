// `Modal` — centered dialog, ESC + backdrop close, focus trap
// (components.md §6 / design.md §8).
//
// Sizes:
//   - 'form'   → 480px (Add/Edit Train, Add/Edit Crew)
//   - 'assign' → 560px (AssignCrewModal)
//
// Behaviour:
//   - `open === false` renders nothing.
//   - On open: scroll lock the body, trap focus inside the panel, focus
//     the first focusable element. On close: restore focus to whatever
//     had it before.
//   - ESC and backdrop click both call `onClose`. Backdrop click only
//     closes when `closeOnBackdrop !== false` (assign modal disables this
//     so an accidental click doesn't lose form state).

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type ModalSize = 'form' | 'assign';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: ModalSize;
  /** Optional description rendered under the title in `--color-text-muted`. */
  subtitle?: string;
  /** Set to false to disable backdrop-click dismissal. */
  closeOnBackdrop?: boolean;
  /**
   * Footer slot — typically `<Cancel/> <Submit/>`. Rendered to the right.
   * Pass `null` for read-only modals; the form itself can render its own
   * actions inside `children` if it prefers.
   */
  footer?: ReactNode;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'form',
  closeOnBackdrop = true,
  footer,
  children,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Stable close handler — used by both ESC and backdrop.
  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  // Body scroll lock + focus restore + ESC handler. All bundled into one
  // effect so the lifecycle stays linear.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        // Cheap focus trap — cycles inside the panel.
        const root = panelRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    // Focus the first focusable element after paint.
    requestAnimationFrame(() => {
      const root = panelRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus();
    };
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // Only close when the click *started* on the backdrop, not on a
        // drag-out from inside the panel.
        if (closeOnBackdrop && e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal modal--${size}`}
      >
        <header className="modal__head">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
