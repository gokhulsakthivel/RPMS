// `AddTrainModal` — wraps `TrainForm` in the `Modal` chrome
// (components.md §8 / design.md §9.1).
//
// On submit, calls `trains.create` and surfaces server-side rule errors
// (e.g. CONFLICT for a duplicate `number`) as a Banner inside the modal.

import { useState } from 'react';
import { ApiError, trains as trainsApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type { TrainCreateInput } from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { TrainForm } from './TrainForm';

export interface AddTrainModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful create so the parent can refetch + toast. */
  onCreated: () => void;
}

export function AddTrainModal({
  open,
  onClose,
  onCreated,
}: AddTrainModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(input: TrainCreateInput) {
    setServerError(null);
    try {
      // M9 — `TrainCreateInput` is now a recurring weekly schedule, not an
      // absolute pair of UTC instants. The form already produces the wire
      // shape; we forward it verbatim.
      await trainsApi.create(input);
      onCreated();
    } catch (e) {
      if (e instanceof ApiError) {
        setServerError(describeApiError(e));
        return; // keep modal open so the operator can fix the form
      }
      throw e;
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Add train"
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't create train">
          {serverError}
        </Banner>
      ) : null}
      <TrainForm
        onSubmit={handleSubmit}
        submitLabel="Add train"
        onCancel={() => {
          setServerError(null);
          onClose();
        }}
      />
    </Modal>
  );
}
