// `EditLinkModal` — wraps `LinkForm` (Edit mode) in the `Modal` chrome.

import { useState } from 'react';
import { ApiError, links as linksApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type { LinkRow } from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { LinkForm } from './LinkForm';

export interface EditLinkModalProps {
  row: LinkRow | null;
  onClose: () => void;
  onUpdated: () => void;
}

export function EditLinkModal({ row, onClose, onUpdated }: EditLinkModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <Modal
      open={row !== null}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title={row ? `Edit ${row.name}` : 'Edit link'}
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't update link">
          {serverError}
        </Banner>
      ) : null}
      {row ? (
        <LinkForm
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
                await linksApi.update(row.id, payload.data);
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
