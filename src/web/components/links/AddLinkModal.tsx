// `AddLinkModal` — wraps `LinkForm` (Add mode) in the `Modal` chrome.

import { useState } from 'react';
import { ApiError, links as linksApi } from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { LinkForm } from './LinkForm';

export interface AddLinkModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddLinkModal({ open, onClose, onCreated }: AddLinkModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={() => {
        setServerError(null);
        onClose();
      }}
      title="Add link"
      size="form"
      closeOnBackdrop={false}
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't create link">
          {serverError}
        </Banner>
      ) : null}
      <LinkForm
        mode="add"
        submitLabel="Add link"
        onCancel={() => {
          setServerError(null);
          onClose();
        }}
        onSubmit={async (payload) => {
          setServerError(null);
          try {
            if (payload.kind === 'CREATE') {
              await linksApi.create(payload.data);
            }
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
