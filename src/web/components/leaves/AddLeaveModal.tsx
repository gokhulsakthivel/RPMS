// `AddLeaveModal` — wraps `LeaveForm` (Add mode) in the `Modal` chrome
// (components.md §11 / design.md §9.5). On success the parent refetches
// and shows a toast.

import { useState } from 'react';
import { ApiError, leaves as leavesApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { LeaveForm } from './LeaveForm';

export interface AddLeaveModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddLeaveModal({ open, onClose, onCreated }: AddLeaveModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Add leave"
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't create leave">
          {serverError}
        </Banner>
      ) : null}
      <LeaveForm
        mode="add"
        submitLabel="Add leave"
        onCancel={() => {
          setServerError(null);
          onClose();
        }}
        onSubmit={async (payload) => {
          setServerError(null);
          try {
            if (payload.kind === 'CREATE') {
              await leavesApi.create(payload.data);
            }
            // Add mode never produces UPDATE — fall through silently.
            onCreated();
          } catch (e) {
            if (e instanceof ApiError) {
              setServerError(describeApiError(e));
              return;
            }
            throw e;
          }
        }}
      />
    </Modal>
  );
}
