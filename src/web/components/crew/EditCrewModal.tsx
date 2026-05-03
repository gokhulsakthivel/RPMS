// `EditCrewModal` — wraps `CrewForm` (Edit mode) in the `Modal` chrome
// (components.md §9 / design.md §9.2). The role toggle is locked, and an
// extra `lastSignOffTime` field is exposed (HLD §4.7 manual override).

import { useMemo, useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpApi,
  locoPilots as lpApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type { CrewRow } from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { CrewForm } from './CrewForm';

export interface EditCrewModalProps {
  /** The row being edited. The modal opens iff `row !== null`. */
  row: CrewRow | null;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditCrewModal({
  row,
  onClose,
  onUpdated,
}: EditCrewModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  // Convert the wire-form `lastSignOffTime: string | null` into a `Date`
  // the form's hydrate path expects.
  const initial = useMemo(() => {
    if (!row) return undefined;
    const iso = row.editable.lastSignOffTime;
    return {
      row,
      lastSignOffTime: iso ? new Date(iso) : null,
    };
  }, [row]);

  return (
    <Modal
      open={row !== null}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Edit crew"
      subtitle={row ? `${row.kind} · ${row.name}` : undefined}
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't update crew member">
          {serverError}
        </Banner>
      ) : null}
      {row ? (
        <CrewForm
          mode="edit"
          initial={initial}
          submitLabel="Save changes"
          onCancel={() => {
            setServerError(null);
            onClose();
          }}
          onSubmit={async (_kind, payload) => {
            setServerError(null);
            try {
              if (payload.kind === 'LP-UPDATE') {
                await lpApi.update(row.id, payload.data);
              } else if (payload.kind === 'ALP-UPDATE') {
                await alpApi.update(row.id, payload.data);
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
