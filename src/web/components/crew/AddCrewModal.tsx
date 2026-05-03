// `AddCrewModal` — wraps `CrewForm` (Add mode) in the `Modal` chrome
// (components.md §9 / design.md §9.2). Routes the LP/ALP toggle to the
// matching API endpoint.

import { useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpApi,
  locoPilots as lpApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { CrewForm } from './CrewForm';

export interface AddCrewModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddCrewModal({ open, onClose, onCreated }: AddCrewModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Add crew"
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't create crew member">
          {serverError}
        </Banner>
      ) : null}
      <CrewForm
        mode="add"
        submitLabel="Add crew"
        onCancel={() => {
          setServerError(null);
          onClose();
        }}
        onSubmit={async (_kind, payload) => {
          setServerError(null);
          try {
            if (payload.kind === 'LP-CREATE') {
              await lpApi.create(payload.data);
            } else if (payload.kind === 'ALP-CREATE') {
              await alpApi.create(payload.data);
            }
            // The dispatch helper only ever produces *-CREATE in 'add' mode,
            // but TypeScript doesn't know that — fall through silently for
            // the unreachable update branches.
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
