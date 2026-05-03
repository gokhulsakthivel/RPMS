// `EditLeaveModal` — wraps `LeaveForm` (Edit mode) in the `Modal` chrome
// (components.md §11 / design.md §9.5). The crew identity (role + member)
// is locked; only type, dates, and reason can be modified.

import { useState } from 'react';
import { ApiError, leaves as leavesApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type { LeaveRow } from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { LeaveForm } from './LeaveForm';

export interface EditLeaveModalProps {
  /** The row being edited. The modal opens iff `row !== null`. */
  row: LeaveRow | null;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditLeaveModal({ row, onClose, onUpdated }: EditLeaveModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <Modal
      open={row !== null}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Edit leave"
      subtitle={row ? `${row.crewRole} · ${row.crewName}` : undefined}
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't update leave">
          {serverError}
        </Banner>
      ) : null}
      {row ? (
        <LeaveForm
          mode="edit"
          initial={row}
          submitLabel="Save changes"
          onCancel={() => {
            setServerError(null);
            onClose();
          }}
          onSubmit={async (payload) => {
            setServerError(null);
            try {
              if (payload.kind === 'UPDATE') {
                await leavesApi.update(row.id, payload.data);
              }
              onUpdated();
            } catch (e) {
              if (e instanceof ApiError) {
                setServerError(describeApiError(e));
                return;
              }
              throw e;
            }
          }}
        />
      ) : null}
    </Modal>
  );
}
