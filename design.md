# Railway People Management System (RPMS) — UI Design

This document covers the **look and feel** of the SPA: layout, color tokens, typography, spacing, states, and interaction patterns. For the **what/why** of the domain, see [`HLD.md`](./HLD.md). For the **how** (types, signatures, error contract), see [`LLD.md`](./LLD.md). For the **stack** (React + Vite + JSON API + CSV), see [`techstack.md`](./techstack.md). The component catalogue lives in [`components.md`](./components.md).

The design is intentionally minimal. RPMS is a **single-user, local-only operator console** — utility beats decoration. Every screen exists to surface a rule decision (eligibility, rest, assignment) and make the operator's next action obvious.

## 1. Design Principles

1. **Rules are visible, not implicit.** If a crew member is hidden from a dropdown, the UI explains why (e.g., "12 of 23 LPs hidden — see filter notes"). Operators never wonder what got filtered.
2. **The 16-hour rest clock is a first-class visual.** Every crew row carries a rest bar. It is the single most-glanced element in the app.
3. **Train type drives layout.** MEMU/DEMU rows hide the ALP slot entirely — not greyed out, not disabled, **gone** — so the operator never has the option to violate the rule.
4. **One color per status.** No gradients, no decorative palettes. Color is information; if it is not informative, it is black, white, or grey.
5. **All time is IST in the UI, UTC on the wire.** Operators see `01 May 2026, 14:30 IST`. The JSON API and CSV both use UTC ISO-8601. Conversion happens once, in `src/shared/time.ts`.
6. **No hidden state.** A refetch after every save is acceptable. The data is small. The UI is a thin projection of the JSON API; the JSON API is a thin projection of the CSV.

## 2. Layout

### 2.1 Page Chrome

```
┌──────────────────────────────────────────────────────────────────────┐
│  RPMS  ·  Railway People Management                       [v0.1.0]   │   ← Header (48px)
├──────────────────────────────────────────────────────────────────────┤
│  [ Trains ]  [ Crew ]  [ Assignments ]                               │   ← Tab bar (44px)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   <Active page content>                                              │   ← Page (fills remainder)
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

- **Header** is fixed at the top, 48px tall, `--color-surface` background, `--color-border` 1px bottom border. The header's right edge holds the **date picker** — a single date input that drives the "selected date" for all three tabs. It defaults to **tomorrow IST** ([HLD §4.6](./HLD.md#46-window-overlap-rule-no-double-booking) is window-based, but the operator's daily view is naturally a one-day-ahead plan). The picker is shared state — switching tabs preserves the selection.
- **Summary strip** sits directly under the header — a row of four `StatCard`s: **Total trains**, **Unassigned trains**, **Available crew**, **Resting crew**. All four numbers are **scoped to the selected date** (see [§9.4](#94-summary-cards-scope) below). Cards have `--color-surface-alt` background, 1px `--color-border`, 12px radius, 16px internal padding. Big number is `--text-h1`; the label sits above it in `--text-caption` `--color-text-muted`.
- **Tab bar** sits below the summary strip. Three tabs: Trains, Crew, Assignments — rendered as **outlined pill buttons**. The active tab is filled with `--color-surface-alt` and outlined in `--color-text` (1.5px); inactive tabs share the same outline at `--color-border` and use `--color-text-muted` for the label. No underlines.
- **Page** is centered with a `max-width: 1200px` and `padding: 24px`. Each page is its own React Router route (`/trains`, `/crew`, `/assignments`). The default route redirects to `/trains`.
- **No sidebar, no footer.** This is a 3-route app on a laptop screen.

### 2.2 Tab Pages

Each of the three tab pages follows the same skeleton:

```
┌──────────────────────────────────────────────────────────────────────┐
│  <Section title>                                    [+ Add new...]   │   ← Section header (h2 + secondary button)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   <DataTable>                                                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The Add button is right-aligned, secondary-style (outlined, not filled). It opens a modal — there are no separate "create" routes. The modal closes and the table refetches on success.

## 3. Color Tokens

The app is **dark theme only**. All colors are defined as CSS custom properties on `:root` in `src/web/styles.css`. **Components never hardcode hex values.** Add a new token rather than adding a one-off color.

### 3.1 Neutrals (dark theme)

| Token                     | Hex       | Use |
|---------------------------|-----------|-----|
| `--color-bg`              | `#0d1117` | Page background (deepest layer) |
| `--color-surface`         | `#161b22` | Cards, table container, modal panel |
| `--color-surface-alt`     | `#1c222b` | Table row hover, active pill tab fill, stat-card surface |
| `--color-border`          | `#30363d` | Dividers, table grid, input borders, inactive pill tab outline |
| `--color-border-strong`   | `#4a5160` | Active pill tab outline, focused input border |
| `--color-text`            | `#f0f6fc` | Body text, table cell content, page title |
| `--color-text-muted`      | `#8b949e` | Column headers, secondary text, timestamps |
| `--color-text-disabled`   | `#6b7280` | Disabled labels, "Not required" cells, empty-state copy |

### 3.2 Brand & Action

| Token                     | Hex       | Use |
|---------------------------|-----------|-----|
| `--color-primary`         | `#3b82f6` | Primary buttons, links |
| `--color-primary-hover`   | `#2563eb` | Primary button hover |
| `--color-primary-soft`    | `#1f2a44` | Selected row, focused chip background |

### 3.3 Crew Status (the rest clock)

These four pairs (background + text) are the most important colors in the app — they encode the 16-hour rule visually. Each status badge is rendered as a soft pill: light tinted background + saturated text, on the dark surface.

| Token                          | Hex       | Use |
|--------------------------------|-----------|-----|
| `--status-available-bg`        | `#dcfce7` | "available" badge background |
| `--status-available-text`      | `#166534` | "available" badge text |
| `--status-resting-bg`          | `#fee2e2` | "resting" badge background |
| `--status-resting-text`        | `#991b1b` | "resting" badge text |
| `--rest-bar-ready`             | `#22c55e` | Rest bar fill when crew is rested or has never signed off (green) |
| `--rest-bar-resting`           | `#ef4444` | Rest bar fill when crew is within the 16-hour window (red) |
| `--rest-bar-track`             | `#30363d` | Rest bar background track (= `--color-border`) |

### 3.4 Feedback

| Token                     | Hex       | Use |
|---------------------------|-----------|-----|
| `--color-success`         | `#22c55e` | Toast on successful assignment |
| `--color-warning`         | `#f59e0b` | Inline rest-warning copy |
| `--color-danger`          | `#ef4444` | "Not assigned" text, form errors, destructive button, rule-violation toast |
| `--color-danger-soft`     | `#3b1d20` | Inline error banner background (dark-tinted) |

### 3.5 Train Type Badges

Each train type renders as a soft pill: light tinted background + saturated text. The two halves are paired tokens.

| Train type      | `--accent-*-bg` | `--accent-*-text` |
|-----------------|-----------------|--------------------|
| `PASSENGER`     | `#dcfce7`       | `#166534`          |
| `MEMU`          | `#fef3c7`       | `#854d0e`          |
| `DEMU`          | `#ccfbf1`       | `#115e59`          |
| `MAIL_EXPRESS`  | `#dbeafe`       | `#1e40af`          |
| `VANDE_BHARAT`  | `#ede9fe`       | `#5b21b6`          |
| `AMRIT_BHARAT`  | `#fce7f3`       | `#9d174d`          |

The same `bg` / `text` pairing pattern applies to the **LP Grade badge** (Mail/Express reuses `--accent-mail-express-*`; Passenger reuses `--accent-passenger-*`) so a Mail/Express LP and a Mail/Express train read as one visual class.

## 4. Typography

System font stack only — no web fonts. The app is local; we don't ship megabytes of font files.

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
             'Helvetica Neue', Arial, sans-serif;
```

| Role            | Size  | Weight | Line-height | Token              |
|-----------------|-------|--------|-------------|--------------------|
| `h1` page title | 24px  | 600    | 32px        | `--text-h1`        |
| `h2` section    | 18px  | 600    | 24px        | `--text-h2`        |
| Body            | 14px  | 400    | 20px        | `--text-body`      |
| Body strong     | 14px  | 600    | 20px        | `--text-body-bold` |
| Caption         | 12px  | 400    | 16px        | `--text-caption`   |
| Mono (IDs, times) | 13px | 400   | 18px        | `--text-mono`      |

Mono uses `ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace` and is reserved for IDs (`TRN_…`, `LP_…`) and timestamps in dense tables.

## 5. Spacing & Sizing

Use the 4-pixel base scale. Half-steps (e.g., 6px, 10px) are not allowed — pick the nearest token.

| Token        | Value | Typical use |
|--------------|-------|-------------|
| `--space-1`  | 4px   | Inline icon gap |
| `--space-2`  | 8px   | Tight grid gap |
| `--space-3`  | 12px  | Form-field internal padding |
| `--space-4`  | 16px  | Default gap between siblings |
| `--space-5`  | 24px  | Section spacing, page padding |
| `--space-6`  | 32px  | Major separator |
| `--space-7`  | 48px  | Empty-state vertical centering |

| Element        | Size                                          |
|----------------|-----------------------------------------------|
| Border radius  | 6px (default), 4px (chips/badges), 12px (modal) |
| Icon size      | 16px (inline), 20px (button), 24px (header)   |
| Button height  | 32px (default), 40px (primary CTA)            |
| Input height   | 36px                                          |
| Table row      | 48px (provides room for the rest bar)         |

## 6. The Rest Bar

The rest bar is the centerpiece of the Crew tab. It is a **horizontal progress bar** showing how many hours of the 16-hour rest window **remain** before the crew member is eligible again.

```
Available     ████████████████  Ready               (green, full bar)
Resting       █████░░░░░░░░░░░  11h left            (red, partial — short fill = lots of rest still required)
Resting       ██░░░░░░░░░░░░░░  6h left             (red, mostly empty)
Brand-new     ████████████████  Ready               (green, full bar)
```

**Visual contract**

- Width: fixed 100px so the bars align across rows; the label sits to its right in `--text-caption`.
- Height: 6px, fully rounded ends.
- Background track: `--color-border` (= `--rest-bar-track`).
- Fill:
  - **Green** (`--rest-bar-ready`) at 100% when the crew is available — `hasSufficientRest === true` or `lastSignOffTime` is undefined. Label: `Ready`.
  - **Red** (`--rest-bar-resting`) at `(hoursRemaining / 16) * 100%` when the crew is within the window. Label: `${Math.ceil(hoursRemaining)}h left`. **Always rounds up** so the operator never sees `0h left` for a non-ready crew. The fill **shrinks toward zero** as the crew approaches eligibility — short fill means only a little rest is left.
- **0-hour edge:** when `hoursRemaining ≤ 0`, the server has already flipped `state` to `'available'`, so the bar collapses to `Ready`. The UI never displays `0h left`.
- The bar is **decorative only** — it does not gate any action by itself. The dropdown filter does. The bar exists so the operator can scan a list and see who is close to ready.

> **Why hours-remaining and not hours-elapsed?** The reference design prioritizes the operator's question — "when can I use this person?" — over the abstract "how much rest have they had?" The numbers in the label always count *down* to zero.

**Calculation lives on the server.** The JSON API returns `restStatus: { state: 'available' | 'resting'; hoursRemaining: number; neverSignedOff: boolean }` for each crew member, so the UI never re-implements the 16-hour rule. The bar is a pure render of that payload.

## 7. States

Every page handles four states explicitly:

| State    | Trigger                                  | UI |
|----------|------------------------------------------|----|
| Loading  | First fetch in-flight                    | Skeleton rows in the table area; header and tab bar render normally. |
| Empty    | API returned `[]`                        | Centered icon + headline (e.g., "No trains yet") + secondary "Click + Add Train to get started." |
| Error    | Fetch failed or API returned non-2xx     | Inline banner across the top of the page: red background (`--color-danger-soft`), red border, retry button. Does not replace the page. |
| Success  | Data loaded                              | Render the table. |

After a mutation (POST/DELETE), show a toast for 3 seconds:
- Success → green check, success copy.
- Error → red, the structured error code mapped to a human string (see [LLD §4](./LLD.md#4-error-contract)).

## 8. Modals

Modals are used for **all** create/edit/assign flows. Rationale: this is a 3-route app; deep linking to a form route adds nothing.

- Centered, `max-width: 480px` (forms) or `max-width: 560px` (assign dialog).
- Backdrop: `rgba(26, 29, 33, 0.5)`.
- 12px corner radius, `--color-surface` background, 24px internal padding.
- ESC closes. Backdrop click closes. Submit on Enter unless focus is in a textarea.
- Submit button is full-width primary; Cancel is text-only to its left.
- Form errors render inline next to the offending field. Server-side rule errors render as a banner inside the modal above the form.

## 9. Tab-Specific Notes

### 9.1 Trains tab

- **Filtered to the selected date.** Shows trains whose `departureTime` falls on the selected calendar date in IST. Default selection is **tomorrow IST** (per [§2.1](#21-page-chrome)).
- Columns: Number · Name · Type (Badge) · Onward route · Departure (IST) · Inward route · Inward arrival (IST) · Currently assigned crew · Actions.
- **Onward route** = `${onwardFromStation} → ${onwardToStation}`.
- **Inward route** = `${inwardTrainNumber} · ${inwardFromStation} → ${inwardToStation}`. These three fields are display-only ([LLD §2](./LLD.md#2-domain-model)) — no rule reads them — but the operator needs the return-leg context at a glance to plan crew turnaround.
- **Departure** and **Inward arrival** render as full IST datetime: `01 May 2026, 14:30 IST` ([§10](#10-time-rendering)).
- "Currently assigned crew" shows two compact chips: `R. Kumar` (LP) and `S. Iyer` (ALP). For MEMU/DEMU, only the LP chip — **the ALP slot is omitted entirely, not shown empty**.
- **Sort order:** by `departureTime` ascending — earliest train of the day at the top.
- **Add Train** modal collects all eleven fields from `data/trains.csv`. Onward and inward times are datetime-local inputs in IST and converted on submit. Server-side validation rejects a duplicate `number` ([LLD §2](./LLD.md#2-domain-model)).
- **Edit Train** opens the same modal, prefilled. `Train.number` is editable but the duplicate-check still applies. Editing a train **does not** mutate prior assignments — `Assignment` carries snapshot copies of `departureTime` and `signOffTime` ([LLD §2](./LLD.md#2-domain-model)).
- **Remove** archives the train ([HLD §4.8](./HLD.md#48-soft-archive-no-hard-deletes)). Always preceded by a `ConfirmDialog`. Past assignments referencing an archived train remain visible for audit.

### 9.2 Crew tab

- Section title: "Crew roster". Right-aligned secondary button: "+ Add crew".
- **One unified table** holds both LPs and ALPs. The role is a column, not a section split.
- **Sort order:** by `name` ascending, case-insensitive. LPs and ALPs interleave alphabetically. The Role column carries the role distinction visually.
- Columns:

  | Column           | Render |
  |------------------|--------|
  | Name             | `--text-body-bold`. **Employee ID is not displayed.** |
  | Role             | `LP` or `ALP`, plain text in `--color-text` |
  | Grade            | A train-type Badge showing the **highest-rank train type the crew member can drive** (rule below) |
  | Status           | `available` Badge (green pair) or `resting` Badge (red pair) |
  | Rest remaining   | `<RestBar>` + label (`Ready` or `Xh left`) |
  | Eligible for     | Comma-separated short labels (`Mail/Express, VB, AB` / `All types` / `Passenger, Mail/Express, VB, AB`) |
  | (action)         | `Edit` icon button + `Remove` text button, right-aligned |

#### Highest-grade rule

The Grade Badge shows the **single highest-rank train type** the crew member can drive, by this ordering (lowest → highest):

```
MEMU < DEMU < PASSENGER < MAIL_EXPRESS < VANDE_BHARAT < AMRIT_BHARAT
```

The "drivable set" used to pick the max:
- **LP:** all `TrainType`s where `isLpEligible(lp, t) === true` ([LLD §3.2](./LLD.md#32-lp-eligibility)) — i.e., the hierarchy-derived set ∪ `eligibleTrainTypes`.
- **ALP:** `alp.eligibleTrainTypes` directly (MEMU/DEMU are forbidden so they never appear).

> **Note on the reference image:** in the pasted reference, two Passenger LPs show a `Passenger` grade badge. Under this rule, those LPs render `Mail/Express` (since hierarchy gives them MAIL_EXPRESS, which outranks PASSENGER). The rule is uniform across LP and ALP; the reference image is illustrative.

The grade is computed **server-side** and arrives as a single `TrainType` field (`row.grade`). The UI never derives it.

#### Eligibility abbreviations

The "Eligible for" column renders a comma-separated list using these short forms (per [C6](#9-tab-specific-notes)):

| `TrainType`     | Short form     |
|-----------------|----------------|
| `PASSENGER`     | `Passenger`    |
| `MAIL_EXPRESS`  | `Mail/Express` |
| `MEMU`          | `MEMU`         |
| `DEMU`          | `DEMU`         |
| `VANDE_BHARAT`  | `VB`           |
| `AMRIT_BHARAT`  | `AB`           |

The list is sorted by the same hierarchy ordering above (MEMU first, AB last) so the cell reads consistently across rows.

**"All types"** appears iff the **effective drivable set covers all 6 `TrainType`s**. Practical implications:
- Mail/Express LPs can never show `All types` — they cannot drive PASSENGER ([LLD §3.2](./LLD.md#32-lp-eligibility)).
- Passenger LPs show `All types` iff `eligibleTrainTypes ⊇ {MEMU, DEMU, VANDE_BHARAT, AMRIT_BHARAT}`.
- ALPs can never show `All types` — MEMU and DEMU are forbidden for ALPs.

#### Actions

- **Edit:** opens the same modal as Add (LP/ALP toggle preset, fields prefilled). The edit form additionally exposes `lastSignOffTime` as an explicit input — this is the manual override path documented in [HLD §4.7](./HLD.md#47-sign-off-time-maintenance).
- **Remove:** archives the row (no hard delete, [HLD §4.8](./HLD.md#48-soft-archive-no-hard-deletes)). Always preceded by a `ConfirmDialog`. The dialog title reads "Archive this crew member?" and the confirm button reads "Archive".

### 9.3 Assignments tab

- **Filtered to the selected date** — shows trains whose `departureTime` falls on the selected calendar date in IST (default: tomorrow).
- Columns: Train (number bold + name) · Type (Badge) · Departure (full IST datetime) · LP · ALP · Action.
- LP cell renders the assigned LP's `name` in `--color-text`, or `Not assigned` in `--color-danger` when empty.
- ALP cell:
  - Assigned → ALP's `name` in `--color-text`.
  - Empty for an ALP-eligible train → `Not assigned` in `--color-danger`.
  - **MEMU / DEMU** → `Not required` in `--color-text-disabled` (muted grey). The cell is **never** an empty Assign target for these train types — see [HLD §4.5](./HLD.md#45-alp-assignment).
- **Sort order:** by `departureTime` ascending.
- Each train that **has no active assignment with an overlapping window** ([HLD §4.6](./HLD.md#46-window-overlap-rule-no-double-booking)) shows an "Assign" button (secondary, outlined) on the right.

#### Filtered-out reasons in the Assign modal

The Assign modal shows the per-dropdown filter footnote (`Hidden: 8 not eligible, 3 still resting, 1 already assigned`). The buckets:

| Bucket               | Rule violated                                |
|----------------------|----------------------------------------------|
| `not eligible`       | [`isLpEligible`](./LLD.md#32-lp-eligibility) / [`isAlpEligible`](./LLD.md#33-alp-eligibility) |
| `still resting`      | [16-hour rest](./HLD.md#43-rest-rule-16-hours) |
| `already assigned`   | [Window overlap with another active assignment](./HLD.md#46-window-overlap-rule-no-double-booking) |
| `archived`           | (Hidden silently — archived crew never appear at all) |

The Assign modal is the heart of the app:
- Header: train number, name, type, departure time.
- Two dropdowns: "Loco Pilot" and "Assistant Loco Pilot".
- For MEMU/DEMU trains, the **ALP dropdown is not rendered** — there is no slot to fill.
- Each dropdown is **pre-filtered server-side** to crew who satisfy: `isLpEligible` / `isAlpEligible` AND `hasSufficientRest` AND no window overlap with any active assignment.
- Filtered-out reasons appear as a grey footnote under the dropdown.
- Submit → POST `/api/assignments`. On success: toast, close, refetch list. On rule error: render the structured error inline in the modal banner.

### 9.4 Summary cards scope

All four `StatCard` numbers are scoped to the **selected date**. Definitions:

| Card                | Definition (scoped to selected date `D` IST) |
|---------------------|----------------------------------------------|
| Total trains        | Active trains whose `departureTime` falls on calendar date `D` IST. |
| Unassigned trains   | Subset of Total trains with **no active assignment** for that train. (For MEMU/DEMU: counted as unassigned iff there is no LP. For others: iff either LP or ALP is missing.) |
| Available crew      | Active crew (LP + ALP combined) whose 16-hour rest is satisfied **as of the start of `D` 00:00 IST** — i.e., `lastSignOffTime` is null OR `lastSignOffTime + 16h ≤ start_of_D_IST_in_UTC`. |
| Resting crew        | Active crew (LP + ALP combined) NOT in Available crew. |

The server endpoint `GET /api/summary?date=YYYY-MM-DD` returns these four counts. The UI never recomputes them.

## 10. Time Rendering

- Server returns ISO-8601 UTC strings (`2026-05-01T14:30:00Z`).
- All UI rendering goes through one helper:

```ts
// src/shared/time.ts
export function renderIST(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso)) + ' IST';
}
```

- All form date/time inputs use `<input type="datetime-local">` and submit as IST; the API layer (or a shared helper) converts to UTC before persistence.

## 11. Responsive & Accessibility

- **Breakpoints:** none. The app targets a laptop (≥ 1280px wide). Below 1024px, content scrolls horizontally — that's acceptable for a local operator console.
- **Contrast:** all text on `--color-bg` and `--color-surface` clears WCAG AA (4.5:1). Status badge text is paired against its own light tinted background (`--status-*-bg` + `--status-*-text`) so the pill itself meets contrast even on the dark surface. Status colors are paired with text labels — never used as the sole signal.
- **Keyboard:** Tab moves through interactive controls in DOM order. Modals trap focus. ESC closes modals. The active tab and the assign button respond to Enter.
- **Focus ring:** 2px outline, `--color-primary`, 2px offset. Never removed. Outline is visible on `:focus-visible` only — mouse clicks do not show the ring.
- **Aria:**
  - Tabs use `role="tablist"` / `role="tab"` / `role="tabpanel"`.
  - Modals use `role="dialog"` with `aria-labelledby` pointing at the modal title.
  - The rest bar uses `role="progressbar"` with `aria-valuemin="0"`, `aria-valuemax="16"`, `aria-valuenow="<hours>"`.

## 12. Out of Scope (Visual)

- Light mode — single dark theme. The reference is dark; we don't ship a toggle.
- Print styles — operators don't print this.
- Animation — only the bare minimum: 120ms ease for hover, 180ms for modal fade. No scroll animations, no skeletons that pulse, no progress spinners with personality.
- Branding — no logo. The header text is the brand.
- Localisation — English-only copy ([techstack.md §8](./techstack.md#8-out-of-scope)).
