# Railway People Management System (RPMS) — Component Catalogue

This document is the **inventory of React components** that make up the SPA. For visual decisions (color, typography, spacing) see [`design.md`](./design.md). For domain types and rules see [`HLD.md`](./HLD.md) and [`LLD.md`](./LLD.md). For the runtime stack see [`techstack.md`](./techstack.md).

## 1. Conventions

- **Location:** all components live under `src/web/components/`. Pages (one per route) live under `src/web/pages/`.
- **Data flow:** components are dumb-by-default. Pages own data fetching with `useEffect` + `fetch('/api/...')`; components receive data via props. No Redux, no TanStack Query, no Context for server data ([techstack.md §2](./techstack.md#2-stack-at-a-glance)).
- **Types:** every component imports its prop types from `src/shared/schemas.ts` (Zod-derived) so the wire shape and the prop shape are the same shape ([techstack.md §7](./techstack.md#7-architecture-layering)).
- **Styling:** plain CSS. One global stylesheet (`src/web/styles.css`) holds tokens; per-component styles use CSS Modules (`Foo.module.css`) when they grow past ~10 lines.
- **Accessibility:** components must satisfy [`design.md` §11](./design.md#11-responsive--accessibility) — focus rings, ARIA roles, keyboard handlers — by construction.
- **No `localStorage`.** Every read and every write goes through the JSON API. The reference UI used `localStorage`; we replace it with `fetch('/api/...')` against the Express server defined in [techstack.md §4–5](./techstack.md#4-project-layout).
- **No hard deletes.** All "Remove" buttons archive the row via `POST /api/<entity>/<id>/archive` ([HLD §4.8](./HLD.md#48-soft-archive-no-hard-deletes)). Every Remove button must be gated by a `<ConfirmDialog>` whose confirm verb reads "Archive" — the operator should never see "Delete" in the UI.
- **Shared selected-date.** All three pages read from a single `useSelectedDate()` hook; the only writer is the `<DatePicker>` in the header. Pages re-fetch when the selected date changes.

## 2. Component Map

```
src/web/
├── App.tsx                       ← Router setup
├── main.tsx                      ← Vite entry point
├── pages/
│   ├── TrainsPage.tsx
│   ├── CrewPage.tsx
│   └── AssignmentsPage.tsx
├── components/
│   ├── chrome/
│   │   ├── Header.tsx
│   │   ├── DatePicker.tsx
│   │   ├── SummaryCards.tsx
│   │   ├── StatCard.tsx
│   │   └── TabBar.tsx
│   ├── primitives/
│   │   ├── Button.tsx
│   │   ├── IconButton.tsx
│   │   ├── Badge.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── Chip.tsx
│   │   ├── Input.tsx
│   │   ├── Select.tsx
│   │   ├── DateTimeInput.tsx
│   │   └── FormField.tsx
│   ├── feedback/
│   │   ├── Banner.tsx
│   │   ├── Toast.tsx
│   │   ├── EmptyState.tsx
│   │   └── SkeletonRows.tsx
│   ├── overlay/
│   │   ├── Modal.tsx
│   │   └── ConfirmDialog.tsx
│   ├── data/
│   │   ├── DataTable.tsx
│   │   └── RestBar.tsx
│   ├── trains/
│   │   ├── TrainTable.tsx
│   │   ├── TrainTypeBadge.tsx
│   │   ├── AddTrainModal.tsx
│   │   └── EditTrainModal.tsx
│   ├── crew/
│   │   ├── CrewTable.tsx
│   │   ├── CrewGradeBadge.tsx
│   │   ├── CrewEligibleForCell.tsx
│   │   ├── AddCrewModal.tsx
│   │   └── EditCrewModal.tsx
│   └── assignments/
│       ├── AssignmentTable.tsx
│       ├── AssignCrewModal.tsx
│       ├── EligibleCrewSelect.tsx
│       └── HiddenCrewFootnote.tsx
└── lib/
    ├── api.ts                    ← typed fetch wrappers
    ├── time.ts                   ← IST/UTC helpers + start-of-day-UTC
    ├── grade.ts                  ← (UI fallback) highest-grade ordering
    └── useSelectedDate.ts        ← shared date state hook
```

## 3. Chrome

### `Header`

Top bar with the app title, version stamp, and the right-aligned `DatePicker`.

```ts
type HeaderProps = { version: string };
```

- 48px tall, sticky (`position: sticky; top: 0`), `--color-surface` background, 1px bottom border.
- Mounts a single `<DatePicker />` instance on the right edge — that picker drives the shared `useSelectedDate()` state consumed by every page.

### `DatePicker`

```ts
type DatePickerProps = {
  value: string;                  // YYYY-MM-DD in IST
  onChange: (next: string) => void;
};
```

- Wraps `<input type="date">`. The value is the **IST calendar date** (string `YYYY-MM-DD`).
- Default value comes from `useSelectedDate()` — initialized to **tomorrow IST** on first mount, persisted only in memory (refresh resets to tomorrow).
- The hook also exports `selectedDateIstStartUtc` (the UTC instant of `00:00 IST` on the selected date) which is what every API call sends as `date=...`.

### `SummaryCards`

The four-stat strip that sits between the Header and the TabBar on every page.

```ts
type SummaryCardsProps = {
  totalTrains: number;
  unassignedTrains: number;
  availableCrew: number;
  restingCrew: number;
};
```

- Always renders four `StatCard`s in a single row, equal width, `gap: var(--space-4)`.
- Numbers come from a single endpoint (`GET /api/summary`) so all three pages render the same values without recomputing on the client.
- `App.tsx` owns the fetch and shares the result across pages via a thin `useSummary()` hook (one source, refetched after every mutation).

### `StatCard`

```ts
type StatCardProps = {
  label: string;       // e.g., "Total trains"
  value: number | string;
};
```

- 12px radius, 1px `--color-border`, `--color-surface-alt` background, 16px padding.
- Label sits on top in `--text-caption` `--color-text-muted`; value below in `--text-h1` `--color-text`.

### `TabBar`

Renders the three top-level tabs and routes via `react-router-dom`.

```ts
type TabBarProps = {
  active: 'trains' | 'crew' | 'assignments';
};
```

- Uses `<NavLink>` so the active state is derived from the URL.
- Each tab is rendered as an **outlined pill** (8px radius, 1.5px outline). The active tab fills with `--color-surface-alt` and outlines in `--color-border-strong`; inactive tabs use `--color-border` and `--color-text-muted`.
- ARIA: `role="tablist"`; each tab is `role="tab"` with `aria-selected`. The page below sets `role="tabpanel"`.

## 4. Primitives

### `Button`

```ts
type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'danger' | 'text';
  size?: 'default' | 'cta';     // 32px or 40px
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
};
```

- Variants map to color tokens from [design.md §3](./design.md#3-color-tokens). `danger` uses `--color-danger`.
- Disabled buttons drop opacity and never show the focus ring.

### `IconButton`

A square 32×32 button with only an icon child. Used for table-row actions (archive, edit).

### `Badge`

```ts
type BadgeProps = {
  label: string;
  bgVar: string;      // CSS custom property name, e.g., '--accent-passenger-bg'
  textVar: string;    // CSS custom property name, e.g., '--accent-passenger-text'
};
```

- Renders an inline-block pill. Background is `bgVar`; text is `textVar`. Used for `TrainTypeBadge` and `CrewGradeBadge`.
- 4px radius, 12px font, 600 weight, 2px vertical / 8px horizontal padding.
- The two-token (bg + text) shape exists because the dark theme requires light tinted pills with darker text — a single accent color cannot satisfy both ([design.md §3.5](./design.md#35-train-type-badges)).

### `StatusBadge`

The crew status pill in the Crew table.

```ts
type StatusBadgeProps = {
  state: 'available' | 'resting';
};
```

- Same visual shape as `Badge`. The `state` selects the corresponding `--status-*-bg` / `--status-*-text` token pair from [design.md §3.3](./design.md#33-crew-status-the-rest-clock).
- Label is the state itself, lowercase: `available`, `resting`.

### `Chip`

A small removable label (used in eligibility lists). Has an optional `onRemove` callback. When `onRemove` is omitted the chip is read-only.

### `Input` / `Select` / `DateTimeInput`

Thin wrappers over native `<input>` / `<select>` / `<input type="datetime-local">`:

- 36px tall, 6px radius, `--color-border` outline, focuses to `--color-primary`.
- `DateTimeInput` accepts and emits **IST** strings; conversion to/from UTC happens in `lib/api.ts` via the helper from [design.md §10](./design.md#10-time-rendering).

### `FormField`

```ts
type FormFieldProps = {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
};
```

- Renders the label, the input slot, and the error/hint row. The error string is the human-readable mapping of an `AssignmentError.code` (see [LLD §4](./LLD.md#4-error-contract)). The mapping table lives once in `src/web/lib/errors.ts`.

## 5. Feedback

### `Banner`

Page-level inline message at the top of a page or inside a modal.

```ts
type BannerProps = {
  tone: 'error' | 'warning' | 'success';
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
};
```

- Used for: load failure (with retry action), structured rule errors during assignment.

### `Toast`

A 3-second auto-dismissing notification stacked at the bottom-right.

```ts
type ToastProps = {
  tone: 'success' | 'error';
  message: string;
};
```

- A small `useToast()` hook in `src/web/lib/toast.tsx` exposes `showToast({ tone, message })`. The hook owns the queue.

### `EmptyState`

```ts
type EmptyStateProps = {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
};
```

### `SkeletonRows`

Renders N grey placeholder rows matching the table's column count while the first fetch is in flight. No pulse animation ([design.md §12](./design.md#12-out-of-scope-visual)).

## 6. Overlays

### `Modal`

```ts
type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  size?: 'form' | 'assign';   // 480px or 560px
  children: React.ReactNode;  // body + actions
};
```

- Traps focus while open; ESC and backdrop click call `onClose`.
- Backdrop is `rgba(26, 29, 33, 0.5)`.
- ARIA: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title.

### `ConfirmDialog`

Specialized modal for destructive actions (archive a train, archive a crew member). Per [components.md §1 Conventions](#1-conventions), the operator never sees "Delete" — every confirm label uses the verb "Archive".

```ts
type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;        // e.g., "Archive train"
  destructive?: boolean;       // styles confirm button as danger
  onConfirm: () => void;
  onCancel: () => void;
};
```

## 7. Data

### `DataTable`

```ts
type Column<Row> = {
  key: string;
  header: string;
  width?: string;
  render: (row: Row) => React.ReactNode;
};

type DataTableProps<Row> = {
  columns: Column<Row>[];
  rows: Row[];
  emptyState: React.ReactNode;
  loading?: boolean;
  rowKey: (row: Row) => string;
};
```

- Single generic table component used by all three pages.
- 48px row height ([design.md §5](./design.md#5-spacing--sizing)).
- Striping uses `--color-surface-alt`.
- When `loading === true`, renders `SkeletonRows`. When `rows.length === 0`, renders `emptyState`.

### `RestBar`

```ts
type RestBarProps = {
  state: 'available' | 'resting';   // from API: restStatus.state
  hoursRemaining: number;            // 0 .. 16
  neverSignedOff?: boolean;          // explicit flag from API
};
```

- Pure presentational. **Does not** compute `state` itself — that comes from the server, anchoring the 16-hour rule to one place ([HLD §4.3](./HLD.md#43-rest-rule-16-hours), [LLD §3.4](./LLD.md#34-rest-rule)).
- Renders a 100px-wide, 6px-tall pill. The track is `--rest-bar-track`. The fill is:
  - `--rest-bar-ready` at 100% when `state === 'available'` or `neverSignedOff === true`. Label to the right: `Ready`.
  - `--rest-bar-resting` at `(hoursRemaining / 16) * 100%` when `state === 'resting'`. Label: `${Math.ceil(hoursRemaining)}h left`.
- ARIA: `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="16"`, `aria-valuenow={hoursRemaining}`, `aria-label="Hours of rest remaining"`.
- Visual contract is defined in [design.md §6](./design.md#6-the-rest-bar).

## 8. Trains

### `TrainTable`

A specialization of `DataTable` with the columns described in [design.md §9.1](./design.md#91-trains-tab):

| Column | Render |
|--------|--------|
| Number | `--text-mono` |
| Name | text |
| Type | `<TrainTypeBadge>` |
| Onward route | `${onwardFromStation} → ${onwardToStation}` |
| Departure | `renderIST(departureTime)` |
| Inward route | `${inwardTrainNumber} · ${inwardFromStation} → ${inwardToStation}` (display-only, [LLD §2](./LLD.md#2-domain-model)) |
| Inward arrival | `renderIST(inwardArrivalTime)` |
| Currently assigned | LP chip + (optional) ALP chip — **ALP chip omitted entirely for MEMU/DEMU** |
| Actions | `<IconButton aria-label="Edit">…</IconButton>` then `<IconButton aria-label="Remove">…</IconButton>` |

```ts
type TrainTableProps = {
  trains: TrainWithAssignment[];
  onEdit: (trainId: string) => void;
  onArchive: (trainId: string) => void;
};
```

- **Sort:** server returns trains scoped to the selected date, sorted by `departureTime` ascending. The component does not re-sort.
- `TrainWithAssignment` is the API response shape — the train plus its current assignment summary, joined server-side so the UI never has to merge.

### `TrainTypeBadge`

```ts
type TrainTypeBadgeProps = { type: TrainType };
```

- Maps `TrainType` → the `--accent-*-bg` / `--accent-*-text` token pair from [design.md §3.5](./design.md#35-train-type-badges).

### `AddTrainModal` / `EditTrainModal`

Both wrap `Modal` with the same field set — the only difference is whether the form is empty or prefilled, and whether the verb is "Add" or "Save".

Fields cover all 11 columns of `data/trains.csv` ([LLD §5.3](./LLD.md#53-schemas)):

`number`, `name`, `type` (Select of `TrainType`), `onwardFromStation`, `onwardToStation`, `departureTime` (DateTimeInput), `inwardTrainNumber`, `inwardFromStation`, `inwardToStation`, `inwardArrivalTime` (DateTimeInput).

```ts
type AddTrainModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;         // page calls refetch
};

type EditTrainModalProps = {
  open: boolean;
  trainId: string | null;      // null while modal is closed
  onClose: () => void;
  onSaved: () => void;
};
```

Client-side validation (Zod, shared with the server schema in `src/shared/schemas.ts`):
- All strings non-empty.
- `inwardArrivalTime > departureTime` (mirrors the loader invariant from [LLD §2](./LLD.md#2-domain-model)).
- `number` uniqueness is checked server-side (the loader rejects duplicates per [LLD §6](./LLD.md#6-coding-standards)).

On submit:
- Add → `POST /api/trains`.
- Edit → `PUT /api/trains/:id`.

On 2xx, call `onSaved` and `onClose`; on 4xx, render the server error in a `Banner` inside the modal. Edits **never** mutate prior assignments — they keep their snapshotted `departureTime` and `signOffTime` ([LLD §2](./LLD.md#2-domain-model)).

## 9. Crew

### `CrewTable`

A **single unified table** containing both LPs and ALPs. Per [design.md §9.2](./design.md#92-crew-tab).

```ts
type CrewTableProps = {
  rows: CrewRow[];
  onEdit: (row: CrewRow) => void;
  onRemove: (row: CrewRow) => void;
};

type CrewRow = {
  id: string;                                  // LP_… or ALP_…
  kind: 'LP' | 'ALP';
  name: string;
  grade: TrainType;                            // highest-rank drivable type (see design.md §9.2)
  status: 'available' | 'resting';
  rest: { hoursRemaining: number; neverSignedOff: boolean };
  eligibleForLabel: string;                    // pre-computed display string (e.g., 'Mail/Express, VB, AB' or 'All types')
};
```

| Column | Render |
|--------|--------|
| Name | `<strong>{name}</strong>` |
| Role | `LP` or `ALP` plain text |
| Grade | `<CrewGradeBadge grade={row.grade} />` |
| Status | `<StatusBadge state={row.status} />` |
| Rest remaining | `<RestBar state={row.status} hoursRemaining={row.rest.hoursRemaining} neverSignedOff={row.rest.neverSignedOff} />` |
| Eligible for | `row.eligibleForLabel` |
| (action) | `<IconButton aria-label="Edit">…</IconButton>` then `<Button variant="text">Remove</Button>` |

- **Sort:** `rows` are sorted server-side by `name` ascending, case-insensitive. The component does not re-sort.
- **Employee ID is intentionally absent** from `CrewRow`. The technical `id` (`LP_…` / `ALP_…`) is the only identifier and is not surfaced in the UI.
- `grade` is always a single `TrainType` — the highest-rank one in the crew member's effective drivable set ([design.md §9.2](./design.md#92-crew-tab)). Server-computed; UI never derives.
- `eligibleForLabel` is computed server-side and reaches the UI ready to render.

### `CrewGradeBadge`

```ts
type CrewGradeBadgeProps = { grade: TrainType };
```

- Renders a `Badge` with the matching train-type accent pair (e.g., `--accent-vande-bharat-bg` / `--accent-vande-bharat-text` for a Vande Bharat-grade crew member).
- Reusing the train-type accents directly creates visual continuity: a Vande Bharat-grade crew member and a Vande Bharat train wear the same color.
- Effectively a thin wrapper over `TrainTypeBadge` — kept as its own name so component imports remain semantically meaningful (`<CrewGradeBadge>` reads better than `<TrainTypeBadge>` inside a crew row).

### `CrewEligibleForCell`

Renders the precomputed string. Kept as its own tiny component so the formatting logic — wrapping, ellipsizing on narrow widths — has one home.

```ts
type CrewEligibleForCellProps = { label: string };
```

### `AddCrewModal` / `EditCrewModal`

Both wrap `Modal`. Add starts empty; Edit starts prefilled and locks the `Role` toggle (you can't morph an LP into an ALP).

The first field on Add is a role toggle:

```
Role:  ( · ) Loco Pilot      ( ) Assistant Loco Pilot
```

When `LP` is selected the modal asks for `name`, `category` (Select), and `eligibleTrainTypes` (multi-select limited to specialties — `MEMU`, `DEMU`, `VANDE_BHARAT`, `AMRIT_BHARAT`).

When `ALP` is selected the modal asks for `name` and `eligibleTrainTypes` (multi-select limited to non-MEMU/DEMU types — `PASSENGER`, `MAIL_EXPRESS`, `VANDE_BHARAT`, `AMRIT_BHARAT`).

**Edit-only field:** `lastSignOffTime` (DateTimeInput, optional, IST). Setting or clearing it is the **manual override** path documented in [HLD §4.7](./HLD.md#47-sign-off-time-maintenance). The Add modal does not expose this — new crew start with no sign-off.

```ts
type AddCrewModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

type EditCrewModalProps = {
  open: boolean;
  crewId: string | null;       // 'LP_…' or 'ALP_…'
  onClose: () => void;
  onSaved: () => void;
};
```

Submit:
- Add LP → `POST /api/loco-pilots`. Add ALP → `POST /api/assistant-loco-pilots`.
- Edit LP → `PUT /api/loco-pilots/:id`. Edit ALP → `PUT /api/assistant-loco-pilots/:id`.

The server-side loader (and Zod schema) re-asserts the invariants from [LLD §6](./LLD.md#6-coding-standards) — the multi-select restriction is a UX nicety, **not** the source of truth.

## 10. Assignments

### `AssignmentTable`

Per [design.md §9.3](./design.md#93-assignments-tab):

| Column | Render |
|--------|--------|
| Train | `<strong>{number}</strong> {name}` |
| Type | `<TrainTypeBadge type={trainType} />` |
| Departure | `renderIST(departureTime)` — full `dd MMM yyyy, HH:mm IST` |
| LP | `lpName` if assigned, else `<span class="danger">Not assigned</span>` |
| ALP | `alpName` if assigned; `<span class="danger">Not assigned</span>` if eligible-but-empty; `<span class="muted">Not required</span>` for MEMU/DEMU |
| Action | `<Button variant="secondary">Assign</Button>` (only when the row has an unfilled slot) |

```ts
type AssignmentTableProps = {
  rows: AssignmentRow[];
  onAssignClick: (trainId: string) => void;
};

type AssignmentRow = {
  trainId: string;
  trainNumber: string;
  trainName: string;
  trainType: TrainType;
  departureTime: string;       // ISO UTC; rendered as HH:mm IST
  lp: { id: string; name: string } | null;
  alp:
    | { id: string; name: string }   // assigned
    | null                            // eligible-but-empty → "Not assigned"
    | 'NOT_REQUIRED';                 // MEMU/DEMU sentinel
  isAssignable: boolean;
};
```

- The server returns the `'NOT_REQUIRED'` sentinel for MEMU/DEMU rows so the UI never derives the rule itself ([HLD §4.5](./HLD.md#45-alp-assignment)).
- The `danger` and `muted` CSS classes wire to `--color-danger` and `--color-text-disabled` from [design.md §3](./design.md#3-color-tokens).

### `AssignCrewModal`

The most rule-laden modal in the app. It is a thin shell that:

1. Receives a `trainId`.
2. Fetches eligible crew via `GET /api/eligible-crew?trainId=...`. The response payload:

```ts
type EligibleCrewResponse = {
  train: Train;
  loco_pilots: { eligible: LpSummary[]; hidden: HiddenCount };
  assistant_loco_pilots: { eligible: AlpSummary[]; hidden: HiddenCount } | null;
  // null when the train is MEMU/DEMU (requiresAlp === false)
};

type HiddenCount = {
  notEligible: number;
  resting: number;
  alreadyAssigned: number;
};
```

3. Renders one `EligibleCrewSelect` for LP, and — only when `assistant_loco_pilots !== null` — one for ALP. **MEMU/DEMU trains do not render an ALP slot at all** ([HLD §4.5](./HLD.md#45-alp-assignment)).
4. On submit, POSTs `/api/assignments` with `{ trainId, lpId, alpId? }`. The server runs `assignCrew` ([LLD §3.5](./LLD.md#35-orchestration)) and either returns the persisted `Assignment` or a structured `AssignmentError`. The error code is mapped to copy via `lib/errors.ts` and rendered in a `Banner` inside the modal.

```ts
type AssignCrewModalProps = {
  open: boolean;
  trainId: string | null;
  onClose: () => void;
  onAssigned: () => void;
};
```

### `EligibleCrewSelect`

A `Select` populated only with crew the server has cleared. The component itself **does not** filter — it trusts the API response. This is the architectural payoff of putting the rules in the domain layer ([HLD §6](./HLD.md#6-high-level-architecture), [LLD §6](./LLD.md#6-coding-standards)): the dropdown cannot accidentally surface an ineligible crew member because the server never sent one.

```ts
type EligibleCrewSelectProps = {
  label: 'Loco Pilot' | 'Assistant Loco Pilot';
  options: { id: string; name: string; restHoursRemaining?: number }[];
  value: string | null;
  onChange: (id: string | null) => void;
  hidden: HiddenCount;
};
```

Renders a `<HiddenCrewFootnote>` directly underneath.

### `HiddenCrewFootnote`

```ts
type HiddenCrewFootnoteProps = { hidden: HiddenCount };
```

- Renders a single muted line: `Hidden: 8 not eligible, 3 still resting, 1 already assigned.`
- Skips zero-count segments. If everything is zero, renders nothing.
- Makes the rule visible without leaking which crew member was filtered or why per row ([design.md §1](./design.md#1-design-principles), point 1).

## 11. API Wrapper (`src/web/lib/api.ts`)

A small typed wrapper so pages and components do not call `fetch` directly:

All list endpoints scoped to a date take `?date=YYYY-MM-DD` (interpreted as IST). All write endpoints respect the soft-archive contract from [LLD §5.5](./LLD.md#55-repository-interfaces) — there is no `DELETE`, only `archive`.

```ts
export const api = {
  trains: {
    list:    (date: string) => http.get<TrainWithAssignment[]>(`/api/trains?date=${date}`),
    create:  (input: CreateTrainInput)              => http.post<Train>('/api/trains', input),
    update:  (id: string, input: UpdateTrainInput)  => http.put<Train>(`/api/trains/${id}`, input),
    archive: (id: string)                            => http.post<void>(`/api/trains/${id}/archive`),
  },
  locoPilots: {
    list:    () => http.get<LpWithRestStatus[]>('/api/loco-pilots'),
    create:  (input: CreateLpInput)                 => http.post<LocoPilot>('/api/loco-pilots', input),
    update:  (id: string, input: UpdateLpInput)     => http.put<LocoPilot>(`/api/loco-pilots/${id}`, input),
    archive: (id: string)                            => http.post<void>(`/api/loco-pilots/${id}/archive`),
  },
  assistantLocoPilots: {
    list:    () => http.get<AlpWithRestStatus[]>('/api/assistant-loco-pilots'),
    create:  (input: CreateAlpInput)                => http.post<AssistantLocoPilot>('/api/assistant-loco-pilots', input),
    update:  (id: string, input: UpdateAlpInput)    => http.put<AssistantLocoPilot>(`/api/assistant-loco-pilots/${id}`, input),
    archive: (id: string)                            => http.post<void>(`/api/assistant-loco-pilots/${id}/archive`),
  },
  assignments: {
    list:         (date: string) => http.get<AssignmentRow[]>(`/api/assignments?date=${date}`),
    eligibleCrew: (trainId: string) => http.get<EligibleCrewResponse>(`/api/eligible-crew?trainId=${trainId}`),
    create:       (input: CreateAssignmentInput) => http.post<Assignment>('/api/assignments', input),
    archive:      (id: string)                    => http.post<void>(`/api/assignments/${id}/archive`),
  },
  summary: {
    get: (date: string) => http.get<{
      totalTrains: number;
      unassignedTrains: number;
      availableCrew: number;
      restingCrew: number;
    }>(`/api/summary?date=${date}`),
  },
};
```

All payload types are imported from `src/shared/schemas.ts`. Error responses with `code: AssignmentError['code']` are surfaced as a typed reject so callers can switch on the code.

## 12. Cross-Reference

| UI element                                  | Backed by rule                          |
|---------------------------------------------|-----------------------------------------|
| `StatusBadge` (`available` / `resting`), `RestBar`, eligibility filter on dropdown | [LLD §3.4](./LLD.md#34-rest-rule), [HLD §4.3](./HLD.md#43-rest-rule-16-hours) |
| LP dropdown filter (Mail vs Passenger)      | [LLD §3.2](./LLD.md#32-lp-eligibility), [HLD §4.2](./HLD.md#42-lp-eligibility-hierarchy-rule) |
| ALP dropdown filter / specialty validation  | [LLD §3.3](./LLD.md#33-alp-eligibility) |
| MEMU/DEMU hides ALP slot in modal; ALP cell renders `Not required` in table | [LLD §3.1](./LLD.md#31-crew-composition), [HLD §4.5](./HLD.md#45-alp-assignment) |
| Inline rule errors in `AssignCrewModal`     | [LLD §4](./LLD.md#4-error-contract) |
| All times rendered IST                      | [design.md §10](./design.md#10-time-rendering) |
| Add forms reject `inwardArrivalTime ≤ departureTime` | [LLD §2](./LLD.md#2-domain-model) |
| `SummaryCards` numbers                      | `GET /api/summary?date=…` scoped to selected date ([design.md §9.4](./design.md#94-summary-cards-scope)) |
| Crew table `Eligible for` label             | Server-derived from `eligibleTrainTypes` + LP hierarchy ([LLD §3.2](./LLD.md#32-lp-eligibility)) |
| Crew table `Grade` badge (`CrewGradeBadge`) | Server-projected highest-rank drivable type, ordering MEMU<DEMU<PASSENGER<MAIL_EXPRESS<VANDE_BHARAT<AMRIT_BHARAT ([design.md §9.2](./design.md#92-crew-tab)) |
| `AssignCrewModal` filters out a crew member with overlapping active assignment | [LLD §3.5](./LLD.md#35-window-overlap), [HLD §4.6](./HLD.md#46-window-overlap-rule-no-double-booking) |
| Every `Remove` button → `ConfirmDialog` (verb "Archive") → `POST /…/archive` | [HLD §4.8](./HLD.md#48-soft-archive-no-hard-deletes) |
| `EditCrewModal` `lastSignOffTime` override field | [HLD §4.7](./HLD.md#47-sign-off-time-maintenance) |
| `DatePicker` is the single writer of selected date; all pages re-fetch on change | [components.md §1 Conventions](#1-conventions) |

## 13. Out of Scope (Components)

- A dedicated **Leaves** page — leave management is out of scope ([HLD §7](./HLD.md#7-out-of-scope-initial-version)).
- An **archived rows** browser — soft-archive support exists at the data layer ([HLD §4.8](./HLD.md#48-soft-archive-no-hard-deletes)) but the UI does not yet expose a "show archived" toggle. Archived rows are inert in all current views.
- A **bulk-assign** workflow — operators assign one train at a time.
- **Charts** of any kind — the rest bar is the only graphical element.
- **Drag-and-drop** assignment — the Assign modal with its filtered dropdown is the only assignment surface.
