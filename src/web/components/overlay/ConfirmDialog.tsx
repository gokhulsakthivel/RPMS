// `ConfirmDialog` — yes/no modal preceding any archive action
// (components.md §6).
//
// design.md §9.1 / §9.2: archive copy reads "Archive" rather than "Delete"
// because archive is soft (HLD §4.8). The confirm button uses the
// `danger` variant when `destructive === true`.

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — string or any inline content. */
  body: ReactNode;
  /** Verb shown on the confirm button (e.g. "Archive"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** Render the confirm button as `danger` (red outline). */
  destructive?: boolean;
  /** While in flight, disables both buttons and shows "…" on confirm. */
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="form"
      footer={
        <>
          <Button variant="text" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? '…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm-dialog__body">{body}</p>
    </Modal>
  );
}
