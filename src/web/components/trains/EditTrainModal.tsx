// `EditTrainModal` — same form as Add, prefilled, calls `trains.update`
// (components.md §8 / design.md §9.1).
//
// Editing a train **does not** mutate prior assignments — at assign time the
// orchestrator materializes the train's recurring schedule against the chosen
// runDate and snapshots the resulting `departureTime` / `signOffTime` onto
// each Assignment (HLD §4.4 / LLD §2 / M9). The modal therefore looks
// indistinguishable from the Add form to the operator.

import { useState } from 'react';
import { ApiError, trains as trainsApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type {
  TrainCreateInput,
  TrainWithAssignment,
} from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { TrainForm } from './TrainForm';

export interface EditTrainModalProps {
  /** The row being edited. The modal opens iff `train !== null`. */
  train: TrainWithAssignment | null;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditTrainModal({
  train,
  onClose,
  onUpdated,
}: EditTrainModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(input: TrainCreateInput) {
    if (!train) return;
    setServerError(null);
    try {
      // M9 — `TrainCreateInput` is a recurring weekly schedule. The form
      // already produces the wire shape; PUT accepts the same fields.
      await trainsApi.update(train.id, input);
      onUpdated();
    } catch (e) {
      if (e instanceof ApiError) {
        setServerError(describeApiError(e));
        return;
      }
      throw e;
    }
  }

  return (
    <Modal
      open={train !== null}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Edit train"
      subtitle={train ? `${train.number} · ${train.name}` : undefined}
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't update train">
          {serverError}
        </Banner>
      ) : null}
      {train ? (
        <TrainForm
          initial={train}
          onSubmit={handleSubmit}
          submitLabel="Save changes"
          onCancel={() => {
            setServerError(null);
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}
