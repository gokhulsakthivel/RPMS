// `MembershipsPanel` — roster for the currently-selected link.
//
// Shows a table of crew anchored to the link, lets the operator add new
// members, edit the anchor of an existing membership, and archive (remove)
// a member. When an `asOfDate` is provided (the shell's DatePicker), each
// row also shows the resolved position for that date.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpApi,
  linkMemberships as membershipsApi,
  locoPilots as lpApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type {
  CrewRow,
  LinkMembershipRow,
  LinkRow,
} from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { EmptyState } from '../feedback/EmptyState';
import { SkeletonRows } from '../feedback/SkeletonRows';
import { useToast } from '../feedback/Toast';
import { ConfirmDialog } from '../overlay/ConfirmDialog';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { FormField } from '../primitives/FormField';
import { IconButton } from '../primitives/IconButton';
import { Input } from '../primitives/Input';
import { Select } from '../primitives/Select';
import { Column, DataTable } from '../data/DataTable';

export interface MembershipsPanelProps {
  link: LinkRow;
  asOfDate: string; // YYYY-MM-DD from the shell DatePicker
  onClose: () => void;
}

export function MembershipsPanel({ link, asOfDate, onClose }: MembershipsPanelProps) {
  const toast = useToast();
  const [rows, setRows] = useState<LinkMembershipRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((n) => n + 1), []);

  // Crew roster for the picker (filtered by link's crewRole).
  const [crew, setCrew] = useState<CrewRow[] | null>(null);
  const [crewError, setCrewError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [archiving, setArchiving] = useState<LinkMembershipRow | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  // Memberships
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    membershipsApi
      .list({ linkId: link.id, asOfDate })
      .then((data) => {
        if (cancelled) return;
        setRows(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [link.id, asOfDate, tick]);

  // Crew list (per role) — used by Add form.
  useEffect(() => {
    let cancelled = false;
    setCrewError(null);
    setCrew(null);
    const loader = link.crewRole === 'LP' ? lpApi.list(asOfDate) : alpApi.list(asOfDate);
    loader
      .then((list) => {
        if (cancelled) return;
        setCrew(list);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCrewError(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [link.crewRole, asOfDate]);

  const memberIds = useMemo(() => new Set((rows ?? []).map((r) => r.crewId)), [rows]);
  const availableCrew = useMemo(() => {
    if (!crew) return [];
    return crew
      .filter((c) => !memberIds.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [crew, memberIds]);

  async function confirmArchive() {
    if (!archiving) return;
    setArchivePending(true);
    try {
      await membershipsApi.archive(archiving.id);
      toast.success(`Removed ${archiving.crewName}`);
      setArchiving(null);
      refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
    } finally {
      setArchivePending(false);
    }
  }

  const columns: ReadonlyArray<Column<LinkMembershipRow>> = [
    {
      key: 'crew',
      header: 'Crew',
      cell: (r) => <Chip role={r.crewRole}>{r.crewName}</Chip>,
    },
    {
      key: 'anchorDate',
      header: 'Anchor date',
      cell: (r) => <time dateTime={r.anchorDate}>{r.anchorDate}</time>,
    },
    {
      key: 'anchorPos',
      header: 'Anchor pos',
      align: 'right',
      cell: (r) => <span>{r.anchorPositionNumber}</span>,
    },
    {
      key: 'today',
      header: `Pos on ${asOfDate}`,
      align: 'right',
      cell: (r) =>
        r.positionOnAsOfDate !== undefined ? (
          <strong>{r.positionOnAsOfDate}</strong>
        ) : (
          <span className="memberships-panel__muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (r) => (
        <IconButton aria-label={`Remove ${r.crewName}`} onClick={() => setArchiving(r)}>
          🗑
        </IconButton>
      ),
    },
  ];

  return (
    <aside className="memberships-panel" aria-label={`Memberships for ${link.name}`}>
      <header className="memberships-panel__header">
        <div>
          <h3 className="memberships-panel__title">{link.name}</h3>
          <p className="memberships-panel__sub">
            {link.crewRole} · cycle {link.cycleLength}
            {link.lpCategory ? ` · ${link.lpCategory.replace('_', ' ').toLowerCase()}` : ''}
          </p>
        </div>
        <div className="memberships-panel__header-actions">
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            + Add member
          </Button>
          <IconButton aria-label="Close memberships panel" onClick={onClose}>
            ✕
          </IconButton>
        </div>
      </header>

      {error ? (
        <Banner tone="error" title="Couldn't load memberships" action={{ label: 'Retry', onClick: refetch }}>
          {error}
        </Banner>
      ) : null}

      {rows === null && !error ? (
        <SkeletonRows rows={5} columns={5} />
      ) : rows && rows.length === 0 ? (
        <EmptyState
          icon="🪪"
          title="No memberships yet"
          description={`Add ${link.crewRole}s to anchor them onto this rotation.`}
          action={{ label: '+ Add member', onClick: () => setAddOpen(true) }}
        />
      ) : rows ? (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      ) : null}

      {addOpen ? (
        <AddMemberInline
          link={link}
          availableCrew={availableCrew}
          crewError={crewError}
          defaultAnchorDate={asOfDate}
          onCancel={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            toast.success('Member added');
            refetch();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        title="Remove this member?"
        body={
          archiving
            ? `${archiving.crewName} will be removed from ${link.name}. The membership row is archived (kept for audit).`
            : ''
        }
        confirmLabel="Remove"
        destructive
        pending={archivePending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inline add — small enough that a dedicated modal would be overkill.
// ---------------------------------------------------------------------------

interface AddMemberInlineProps {
  link: LinkRow;
  availableCrew: ReadonlyArray<CrewRow>;
  crewError: string | null;
  defaultAnchorDate: string;
  onCancel: () => void;
  onCreated: () => void;
}

function AddMemberInline({
  link,
  availableCrew,
  crewError,
  defaultAnchorDate,
  onCancel,
  onCreated,
}: AddMemberInlineProps) {
  const [crewId, setCrewId] = useState<string>('');
  const [anchorDate, setAnchorDate] = useState<string>(defaultAnchorDate);
  const [anchorPositionNumber, setAnchorPositionNumber] = useState<string>('1');
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const pos = Number(anchorPositionNumber);
    if (!crewId) {
      setServerError('Pick a crew member');
      return;
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > link.cycleLength) {
      setServerError(`Anchor position must be in [1..${link.cycleLength}]`);
      return;
    }
    setPending(true);
    try {
      await membershipsApi.create({
        linkId: link.id,
        crewId,
        crewRole: link.crewRole,
        anchorDate,
        anchorPositionNumber: pos,
      });
      onCreated();
    } catch (e) {
      setServerError(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="memberships-panel__add" onSubmit={submit} noValidate>
      <h4 className="memberships-panel__add-title">Add member</h4>
      {crewError ? (
        <Banner tone="error" title="Couldn't load crew list">
          {crewError}
        </Banner>
      ) : null}
      {serverError ? <Banner tone="error">{serverError}</Banner> : null}
      <FormField label="Crew member" required>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={crewId}
            onChange={(e) => setCrewId(e.currentTarget.value)}
          >
            <option value="">— select —</option>
            {availableCrew.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Anchor date" required>
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="date"
            aria-describedby={describedBy}
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.currentTarget.value)}
          />
        )}
      </FormField>
      <FormField label="Anchor position" required hint={`1..${link.cycleLength}`}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={link.cycleLength}
            step={1}
            aria-describedby={describedBy}
            value={anchorPositionNumber}
            onChange={(e) => setAnchorPositionNumber(e.currentTarget.value)}
          />
        )}
      </FormField>
      <div className="memberships-panel__add-actions">
        <Button variant="text" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add member'}
        </Button>
      </div>
    </form>
  );
}
