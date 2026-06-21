# Railway People Management System (RPMS) — Low-Level Design

This document covers the **how**: data models, function signatures, validation contracts, error shapes, coding standards, and tests. For the **what** and **why** (domain, business rules, workflows), see [`HLD.md`](./HLD.md).

## 1. Type Definitions

### 1.1 Enums
```ts
enum TrainType {
  PASSENGER     = 'PASSENGER',
  MEMU          = 'MEMU',
  DEMU          = 'DEMU',
  MAIL_EXPRESS  = 'MAIL_EXPRESS',
  VANDE_BHARAT  = 'VANDE_BHARAT',
  AMRIT_BHARAT  = 'AMRIT_BHARAT',
}

enum LpCategory {
  MAIL_EXPRESS = 'MAIL_EXPRESS', // role label only — NOT used in eligibility
  PASSENGER    = 'PASSENGER',    // role label only — NOT used in eligibility
}
```

### 1.2 Constants
```ts
const MIN_REST_HOURS = 16;
// Single source of truth for the rest window.
// Update only here when policy changes.
```

### 1.3 Link Enums
```ts
enum LinkPositionKind {
  DUTY = 'DUTY',  // one tour of duty (1+ segments chained as one continuous tour)
  OFF  = 'OFF',   // single off day
  PR   = 'PR',    // periodic rest block
}
```

## 2. Domain Model

```ts
interface LocoPilot {
  id: string;
  name: string;
  category: LpCategory;          // role label only — eligibility ignores this
  // Train types this LP is certified to drive — source of truth for
  // eligibility (see `isLpEligible`). MAY include any of the six TrainType
  // values, including PASSENGER and MAIL_EXPRESS.
  eligibleTrainTypes: TrainType[];
  lastSignOffTime?: Date;        // UTC; undefined for brand-new crew
  archivedAt?: Date;             // UTC; undefined for active rows
}

interface AssistantLocoPilot {
  id: string;
  name: string;
  // Train types this ALP is certified for. MEMU and DEMU MUST NOT appear here
  // (those train types do not require an ALP).
  eligibleTrainTypes: TrainType[];
  lastSignOffTime?: Date;        // UTC; undefined for brand-new crew
  archivedAt?: Date;             // UTC; undefined for active rows
}

interface Train {
  id: string;
  number: string;                // unique and stable across time
  name: string;
  type: TrainType;
  onwardFromStation: string;     // origin station for the outbound leg
  onwardToStation: string;       // destination of the outbound leg
  departureTime: Date;           // UTC, onward departure = crew sign-on
  inwardTrainNumber: string;     // display-only; no rule reads this
  inwardFromStation: string;     // display-only
  inwardToStation: string;       // display-only
  inwardArrivalTime: Date;       // UTC, return arrival at origin = crew sign-off
  archivedAt?: Date;             // UTC; undefined for active rows
}

interface Assignment {
  id: string;
  trainId: string;
  lpId: string;
  alpId?: string;                // absent for MEMU/DEMU
  departureTime: Date;           // UTC, copied from train (sign-on)
  signOffTime: Date;             // UTC, copied from train.inwardArrivalTime
  createdAt: Date;               // UTC
  archivedAt?: Date;             // UTC; undefined for active rows
}
```

**Loader-enforced invariants:**
- `Train.inwardArrivalTime > Train.departureTime`. Reject the row otherwise.
- `Train.number` is **unique** across all (active and archived) train rows. Reject duplicate-number rows on load.
- `archivedAt` is either absent or a valid UTC timestamp ≥ the row's `createdAt` (where applicable).

### 2.1 Link Domain Model

```ts
type CrewRole = 'LP' | 'ALP';

interface LinkSegment {
  /** Train number — joined to `Train.number` (the stable, unique identifier). */
  trainNumber: string;
  /** IST `HH:MM` (24h) — sign-on at the start of this segment. */
  signOnTimeOfDay: string;
  /** IST `HH:MM` (24h) — sign-off at the end of this segment. */
  signOffTimeOfDay: string;
  /** 0 = same IST day as the position's run date, 1 = next day, ... */
  signOffDayOffset: number;
}

type LinkPosition =
  | { positionNumber: number; kind: 'DUTY'; segments: LinkSegment[] }   // segments.length >= 1
  | { positionNumber: number; kind: 'OFF' }
  | { positionNumber: number; kind: 'PR'  };

interface Link {
  id: string;                         // PK, prefix `LNK_`
  name: string;                       // e.g., "CBE MAIL LINK - 19 MEN"
  crewRole: CrewRole;
  /** Optional role label — only meaningful when `crewRole === 'LP'`. */
  lpCategory?: LpCategory;
  /** Number of positions in the cycle. MUST equal `positions.length`. */
  cycleLength: number;
  /** Ordered list — `positions[i].positionNumber` MUST equal `i + 1`. */
  positions: LinkPosition[];
  createdAt: Date;                    // UTC
  archivedAt?: Date;                  // UTC; undefined for active rows
}

interface LinkMembership {
  id: string;                         // PK, prefix `LMB_`
  linkId: string;                     // FK → Link.id
  crewId: string;                     // FK → LP.id or ALP.id (matches crewRole)
  crewRole: CrewRole;                 // MUST equal parent Link.crewRole
  /** IST calendar date `YYYY-MM-DD` at which `anchorPositionNumber` applies. */
  anchorDate: string;
  /** 1-based position the crew member sits at on `anchorDate`. */
  anchorPositionNumber: number;
  createdAt: Date;                    // UTC
  archivedAt?: Date;                  // UTC; undefined for active rows
}
```

**Loader-enforced invariants for Link:**
- `cycleLength >= 1` and `positions.length === cycleLength`.
- `positions[i].positionNumber === i + 1` for every position.
- Every `DUTY` position has at least one segment.
- Every segment has a non-empty `trainNumber` and `HH:MM` time strings.
- `signOffDayOffset` is an integer in `[0..3]`.
- `lpCategory` is set **only** when `crewRole === 'LP'`.

**Loader-enforced invariants for LinkMembership:**
- `crewRole` matches the parent Link's `crewRole`.
- `anchorPositionNumber` is in `[1..cycleLength]`.
- `anchorDate` is a valid `YYYY-MM-DD`.

## 3. Validation Functions

### 3.1 Crew Composition
```ts
function requiresAlp(trainType: TrainType): boolean {
  // Returns false ONLY for MEMU and DEMU.
  return trainType !== TrainType.MEMU && trainType !== TrainType.DEMU;
}
```

### 3.2 LP Eligibility
```ts
function isLpEligible(lp: LocoPilot, trainType: TrainType): boolean {
  // Eligibility is fully data-driven. The LP's `eligibleTrainTypes` list IS
  // the drivable set — including PASSENGER and MAIL_EXPRESS. `LpCategory` is
  // a role label only and does not participate in this decision.
  return lp.eligibleTrainTypes.includes(trainType);
}
```

### 3.3 ALP Eligibility
```ts
function isAlpEligible(alp: AssistantLocoPilot, trainType: TrainType): boolean {
  // ALPs are never assigned to MEMU or DEMU. Defense-in-depth: even if data is
  // somehow corrupted to include those types, reject here.
  if (trainType === TrainType.MEMU || trainType === TrainType.DEMU) return false;
  return alp.eligibleTrainTypes.includes(trainType);
}
```

### 3.4 Rest Rule
```ts
function hasSufficientRest(
  crew: { lastSignOffTime?: Date },
  trainDepartureTime: Date,
): boolean {
  if (!crew.lastSignOffTime) return true; // brand-new crew
  const diffHours = (trainDepartureTime.getTime() - crew.lastSignOffTime.getTime()) / (1000 * 60 * 60);
  return diffHours >= MIN_REST_HOURS;
}
```

> Note: `computeAssumedArrival` no longer exists. The train carries
> `inwardArrivalTime` directly; the assignment copies it into `signOffTime`.

### 3.5 Window Overlap

```ts
function hasWindowConflict(
  candidateWindow: { departureTime: Date; signOffTime: Date },
  existingAssignments: Assignment[],   // already filtered to active (non-archived)
): boolean {
  // Closed-interval overlap on [departureTime, signOffTime].
  // Two intervals [a, b] and [c, d] overlap iff a <= d AND c <= b.
  return existingAssignments.some(a =>
    candidateWindow.departureTime.getTime() <= a.signOffTime.getTime() &&
    a.departureTime.getTime() <= candidateWindow.signOffTime.getTime()
  );
}
```

The orchestrator passes only **active** assignments — archived ones are excluded by the repository layer.

### 3.6 Orchestration
```ts
function assignCrew(input: {
  train: Train;
  lp: LocoPilot;
  alp?: AssistantLocoPilot;
  lpAssignments: Assignment[];        // active assignments held by lp
  alpAssignments?: Assignment[];      // active assignments held by alp (when provided)
}): Result<Assignment, AssignmentError> {
  // 0. Reject archived inputs                          → ARCHIVED_ENTITY
  //    (any of train, lp, alp has archivedAt set)
  // 1. Check LP eligibility (isLpEligible)             → LP_NOT_ELIGIBLE
  // 2. Check LP rest (hasSufficientRest)               → LP_REST_VIOLATION
  // 3. Check LP window overlap (hasWindowConflict)     → LP_WINDOW_CONFLICT
  // 4. If requiresAlp(train.type):
  //      4a. Ensure alp is provided                    → ALP_REQUIRED_BUT_MISSING
  //      4b. Check ALP eligibility (isAlpEligible)     → ALP_NOT_ELIGIBLE
  //      4c. Check ALP rest                            → ALP_REST_VIOLATION
  //      4d. Check ALP window overlap                  → ALP_WINDOW_CONFLICT
  //    Else (MEMU / DEMU):
  //      4e. Reject if alp was supplied                → ALP_NOT_ALLOWED
  // 5. Persist Assignment with signOffTime = train.inwardArrivalTime.
  // 6. Update lastSignOffTime on both LP and ALP records to train.inwardArrivalTime.
}
```

> The operator may **manually override** `lastSignOffTime` via the Edit Crew flow ([HLD §4.7](./HLD.md#47-sign-off-time-maintenance)). That path goes through the repo's `update(id, patch)` and is **not** part of `assignCrew`.

### 3.7 Link Position Resolution

Pure helper (no I/O, no `Date.now()`):

```ts
function positionOnDate(
  link: { cycleLength: number },
  membership: { anchorDate: string; anchorPositionNumber: number },
  runDate: string,            // IST 'YYYY-MM-DD'
): number {
  // 1. Compute integer-day delta between runDate and anchorDate (IST).
  // 2. positionOnDate = ((anchorPositionNumber - 1 + delta) mod cycleLength) + 1
  //    — with the caveat that JS '%' is sign-preserving; use a safe mod.
  // Returns a 1-based position number in [1..cycleLength].
}
```

The helper's `runDate` may be **before** the anchor — `delta` is allowed to be negative. The implementation MUST use a sign-safe modulo so a runDate one day before anchor on a 19-position link returns position 19 (not -1). The companion helper:

```ts
function resolvePositionForRun(
  link: Link,
  membership: LinkMembership,
  runDate: string,
): { positionNumber: number; position: LinkPosition };
```

returns the resolved `LinkPosition` itself for callers that need to inspect the segments.

> §4.11 — **Auto-Draft only.** The link-aware rest exception is implemented at the auto-draft caller, never inside `hasSufficientRest`. `MIN_REST_HOURS` does not move.

## 4. Error Contract

Errors are **structured** so the UI can render actionable messages. Never throw raw strings.

```ts
type AssignmentError =
  | { code: 'LP_NOT_ELIGIBLE'; lpId: string; trainType: TrainType }
  | { code: 'LP_REST_VIOLATION'; lpId: string; requiredHours: number; actualHours: number }
  | { code: 'LP_WINDOW_CONFLICT'; lpId: string; conflictingAssignmentId: string }
  | { code: 'ALP_NOT_ELIGIBLE'; alpId: string; trainType: TrainType }
  | { code: 'ALP_REST_VIOLATION'; alpId: string; requiredHours: number; actualHours: number }
  | { code: 'ALP_WINDOW_CONFLICT'; alpId: string; conflictingAssignmentId: string }
  | { code: 'ALP_REQUIRED_BUT_MISSING'; trainType: TrainType }
  | { code: 'ALP_NOT_ALLOWED'; trainType: TrainType }            // MEMU/DEMU
  | { code: 'ARCHIVED_ENTITY'; entity: 'TRAIN' | 'LP' | 'ALP'; id: string };
```

- `LP_NOT_ELIGIBLE` covers any LP whose `eligibleTrainTypes` does not include the train's type (covers all six train types — there is no separate hierarchy/cert split).
- `ALP_NOT_ELIGIBLE` covers an ALP whose `eligibleTrainTypes` does not include the train's type.
- `LP_WINDOW_CONFLICT` / `ALP_WINDOW_CONFLICT` cover the no-double-booking rule ([HLD §4.6](./HLD.md#46-window-overlap-rule-no-double-booking)).
- `ARCHIVED_ENTITY` is raised when `assignCrew` is called against any archived row.

### 4.1 Link Validation Errors

Phase-1-only — these surface from `POST /api/links` and `POST /api/link-memberships`. They are **not** part of the assignment orchestrator's error union:

```ts
type LinkValidationError =
  | { code: 'LINK_INVALID_CYCLE_LENGTH'; received: number }
  | { code: 'LINK_POSITION_COUNT_MISMATCH'; cycleLength: number; received: number }
  | { code: 'LINK_POSITION_NUMBER_MISMATCH'; expected: number; received: number; index: number }
  | { code: 'LINK_DUTY_NEEDS_SEGMENT'; positionNumber: number }
  | { code: 'LINK_LP_CATEGORY_FOR_ALP' }
  | { code: 'LINK_MEMBERSHIP_ROLE_MISMATCH'; expected: CrewRole; received: CrewRole }
  | { code: 'LINK_MEMBERSHIP_POSITION_OUT_OF_RANGE'; cycleLength: number; received: number }
  | { code: 'LINK_NOT_FOUND'; linkId: string }
  | { code: 'LINK_CREW_NOT_FOUND'; crewId: string; crewRole: CrewRole };
```

These codes are mostly defence-in-depth — the Zod schemas in `src/shared/schemas.ts` reject the same inputs at the route boundary first.

## 5. Persistence

CSV-backed and **repo-local**. The four files under `data/` are the system of record. There is no database.

### 5.1 File Layout
```
data/
├── trains.csv
├── loco_pilots.csv
├── assistant_loco_pilots.csv
├── assignments.csv
├── leaves.csv
├── assignment_drafts.csv
├── links.csv
└── link_memberships.csv
```

### 5.2 File Format Rules
- **Encoding:** UTF-8, `\n` line endings.
- **Quoting:** RFC 4180. Quote any field containing `,`, `"`, or newline; escape `"` as `""`.
- **Timestamps:** ISO 8601 UTC, e.g. `2026-05-01T14:30:00Z`. No IST on disk.
- **Empty string** = `undefined`/null.
- **Lists** (e.g., `eligibleTrainTypes`) are pipe-delimited within a single field: `MEMU|VANDE_BHARAT`. Empty cell = empty list.
- **Header row is mandatory** and is part of the contract — readers must assert exact match on load.
- **ID prefixes:** `TRN_`, `LP_`, `ALP_`, `ASN_`, `LEAVE_`, `LNK_`, `LMB_`. IDs are opaque strings; any uniqueness scheme is acceptable.

### 5.3 Schemas

> Every entity CSV ends with an `archivedAt` column. Empty = active.

#### `trains.csv`
```
id,number,name,type,onwardFromStation,onwardToStation,departureTime,inwardTrainNumber,inwardFromStation,inwardToStation,inwardArrivalTime,archivedAt
```
| Column                | Type     | Notes |
|-----------------------|----------|-------|
| `id`                  | string   | PK, prefix `TRN_` |
| `number`              | string   | Onward train number — **unique across all rows (active + archived)** |
| `name`                | string   | |
| `type`                | enum     | `TrainType` |
| `onwardFromStation`   | string   | |
| `onwardToStation`     | string   | |
| `departureTime`       | ISO-UTC  | Crew sign-on |
| `inwardTrainNumber`   | string   | Display-only |
| `inwardFromStation`   | string   | Display-only |
| `inwardToStation`     | string   | Display-only |
| `inwardArrivalTime`   | ISO-UTC  | Crew sign-off; must be `> departureTime` |
| `archivedAt`          | ISO-UTC  | Empty for active rows |

#### `loco_pilots.csv`
```
id,name,category,eligibleTrainTypes,lastSignOffTime,archivedAt
```
| Column               | Type     | Notes |
|----------------------|----------|-------|
| `id`                 | string   | PK, prefix `LP_` |
| `name`               | string   | |
| `category`           | enum     | `LpCategory` |
| `eligibleTrainTypes` | pipe-list| Source of truth for eligibility. May contain any of the six TrainType values, including `PASSENGER` and `MAIL_EXPRESS`. Empty if none. |
| `lastSignOffTime`    | ISO-UTC  | Empty for brand-new crew |
| `archivedAt`         | ISO-UTC  | Empty for active rows |

#### `assistant_loco_pilots.csv`
```
id,name,eligibleTrainTypes,lastSignOffTime,archivedAt
```
| Column               | Type     | Notes |
|----------------------|----------|-------|
| `id`                 | string   | PK, prefix `ALP_` |
| `name`               | string   | |
| `eligibleTrainTypes` | pipe-list| Train types this ALP is certified for. **MEMU/DEMU must NOT appear.** |
| `lastSignOffTime`    | ISO-UTC  | Empty for brand-new crew |
| `archivedAt`         | ISO-UTC  | Empty for active rows |

#### `assignments.csv`
```
id,trainId,lpId,alpId,departureTime,signOffTime,createdAt,archivedAt
```
| Column          | Type     | Notes |
|-----------------|----------|-------|
| `id`            | string   | PK, prefix `ASN_` |
| `trainId`       | FK       | → `trains.id` |
| `lpId`          | FK       | → `loco_pilots.id` |
| `alpId`         | FK       | → `assistant_loco_pilots.id`; **empty for MEMU/DEMU** |
| `departureTime` | ISO-UTC  | Sign-on, copied from train at create time |
| `signOffTime`   | ISO-UTC  | Sign-off, copied from `train.inwardArrivalTime` |
| `createdAt`     | ISO-UTC  | When the row was persisted |
| `archivedAt`    | ISO-UTC  | Empty for active rows |

#### `links.csv`
```
id,name,crewRole,lpCategory,cycleLength,positions,createdAt,archivedAt
```
| Column         | Type     | Notes |
|----------------|----------|-------|
| `id`           | string   | PK, prefix `LNK_` |
| `name`         | string   | e.g., `CBE MAIL LINK - 19 MEN` |
| `crewRole`     | enum     | `LP` or `ALP` |
| `lpCategory`   | enum     | Optional. Only set when `crewRole = LP`. Empty otherwise. |
| `cycleLength`  | integer  | ≥ 1; MUST equal `positions.length` |
| `positions`    | JSON     | UTF-8 JSON array of `LinkPosition` (escaped per RFC 4180). See §2.1. |
| `createdAt`    | ISO-UTC  | |
| `archivedAt`   | ISO-UTC  | Empty for active rows |

> **Why JSON-in-CSV for `positions`?** A link's positions form an irregular, deeply-nested structure (DUTY may have 1–8 segments; OFF/PR carry no segments). A separate `link_positions.csv` would force a join on every read for very little gain — there is one Link per several thousand assignments, and writes go through a single repo. RFC 4180 quoting handles JSON correctly via the existing `csvIo` helpers; we never parse this column outside the repo.

#### `link_memberships.csv`
```
id,linkId,crewId,crewRole,anchorDate,anchorPositionNumber,createdAt,archivedAt
```
| Column                 | Type     | Notes |
|------------------------|----------|-------|
| `id`                   | string   | PK, prefix `LMB_` |
| `linkId`               | FK       | → `links.id` |
| `crewId`               | FK       | → `loco_pilots.id` or `assistant_loco_pilots.id` (per `crewRole`) |
| `crewRole`             | enum     | `LP` or `ALP`. MUST equal parent Link's `crewRole`. |
| `anchorDate`           | YYYY-MM-DD | IST calendar date the anchor position applies to |
| `anchorPositionNumber` | integer  | 1-based, ≤ parent Link's `cycleLength` |
| `createdAt`            | ISO-UTC  | |
| `archivedAt`           | ISO-UTC  | Empty for active rows |

### 5.4 Write Discipline
- **Whole-file rewrite.** Any update — including `lastSignOffTime` mutations and new assignment rows — rewrites the entire file.
- **Atomic write.** Write to `<file>.tmp`, then `rename()` over the original. Prevents half-written files on crash.
- **Single-writer.** A `data/.lock` file (or in-process mutex for single-process deployments) serializes writes. CSV has no MVCC.
- **Referential integrity** is enforced by the repository layer on load (e.g., reject any `assignments` row whose `lpId` is not in `loco_pilots.csv`). CSV cannot enforce FKs natively.

### 5.5 Repository Interfaces

All `list*` methods return **active rows only** by default. Archived rows are reachable via the `*IncludingArchived` variants. There is no `delete` — `archive(id)` sets `archivedAt = now()` and rewrites the file under the lock.

```ts
type ActiveFilter = { includeArchived?: boolean };
type DateRange    = { fromUtc: Date; toUtcExclusive: Date };

interface LocoPilotRepo {
  findById(id: string, opts?: ActiveFilter): Promise<LocoPilot | null>;
  list(opts?: ActiveFilter): Promise<LocoPilot[]>;
  create(input: Omit<LocoPilot, 'id' | 'archivedAt'>): Promise<LocoPilot>;
  update(id: string, patch: Partial<Omit<LocoPilot, 'id'>>): Promise<LocoPilot>;
  updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void>;
  archive(id: string): Promise<void>;
}

interface AssistantLocoPilotRepo {
  findById(id: string, opts?: ActiveFilter): Promise<AssistantLocoPilot | null>;
  list(opts?: ActiveFilter): Promise<AssistantLocoPilot[]>;
  create(input: Omit<AssistantLocoPilot, 'id' | 'archivedAt'>): Promise<AssistantLocoPilot>;
  update(id: string, patch: Partial<Omit<AssistantLocoPilot, 'id'>>): Promise<AssistantLocoPilot>;
  updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void>;
  archive(id: string): Promise<void>;
}

interface TrainRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Train | null>;
  list(opts?: ActiveFilter & { departingWithin?: DateRange }): Promise<Train[]>;
  findByNumber(number: string, opts?: ActiveFilter): Promise<Train | null>; // uniqueness check
  create(input: Omit<Train, 'id' | 'archivedAt'>): Promise<Train>;
  update(id: string, patch: Partial<Omit<Train, 'id'>>): Promise<Train>;
  archive(id: string): Promise<void>;
}

interface AssignmentRepo {
  create(a: Omit<Assignment, 'id' | 'createdAt' | 'archivedAt'>): Promise<Assignment>;
  list(opts?: ActiveFilter & { departingWithin?: DateRange }): Promise<Assignment[]>;
  listByCrew(crewId: string, opts?: ActiveFilter): Promise<Assignment[]>;
  listByTrain(trainId: string, opts?: ActiveFilter): Promise<Assignment[]>;
  archive(id: string): Promise<void>;
}

interface LinkRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Link | null>;
  list(opts?: ActiveFilter): Promise<Link[]>;
  create(input: Omit<Link, 'id' | 'createdAt' | 'archivedAt'>): Promise<Link>;
  update(id: string, patch: Partial<Omit<Link, 'id' | 'createdAt'>>): Promise<Link>;
  archive(id: string): Promise<void>;
}

interface LinkMembershipRepo {
  findById(id: string, opts?: ActiveFilter): Promise<LinkMembership | null>;
  list(opts?: ActiveFilter): Promise<LinkMembership[]>;
  listByLink(linkId: string, opts?: ActiveFilter): Promise<LinkMembership[]>;
  listByCrew(crewId: string, opts?: ActiveFilter): Promise<LinkMembership[]>;
  create(input: Omit<LinkMembership, 'id' | 'createdAt' | 'archivedAt'>): Promise<LinkMembership>;
  update(id: string, patch: Partial<Omit<LinkMembership, 'id' | 'createdAt'>>): Promise<LinkMembership>;
  archive(id: string): Promise<void>;
}
```

- `update(id, patch)` performs a whole-file rewrite under the same lock as creates and archives. Editing `lastSignOffTime` directly via `update` is the manual override path documented in [HLD §4.7](./HLD.md#47-sign-off-time-maintenance); routine sign-off changes should use `updateLastSignOff` so intent is explicit at the call site.
- `departingWithin` filters by `departureTime ∈ [fromUtc, toUtcExclusive)` and is the single source of truth for the date filter that powers the Trains, Assignments, and Summary endpoints.
- The CSV-backed implementations (`CsvLocoPilotRepo`, `CsvAssistantLocoPilotRepo`, `CsvTrainRepo`, `CsvAssignmentRepo`) are the only adapters in scope. File paths come from configuration — no hardcoded paths in code.

## 6. Coding Standards
- Treat the rules from [HLD §4](./HLD.md#4-core-business-rules) as **invariants** — enforce them in the domain layer, not only the UI.
- Use enums/union types for `TrainType` and `LpCategory` — never raw strings in business logic.
- Return structured errors (see §4); the UI maps `code` → message.
- All time math must be timezone-aware (IST). **Store** timestamps in UTC; **render** in IST.
- `MIN_REST_HOURS` is the only place where `16` may appear in the code. No magic literals elsewhere.
- Roster counts (16/16/29) live in **configuration**, not in code. The roster is expected to grow.
- Pure validation functions must be deterministic and side-effect free — they take inputs and return outputs with no I/O, no `Date.now()`, no `Math.random()`. The orchestrator passes the current time in.
- **CSV is the system of record.** Never bypass the repository layer to read or write `data/*.csv` directly from application code.
- **CSV writes are whole-file, atomic (temp + rename), and serialized.** No partial-row updates.
- **CSV column order is part of the contract.** Loaders must assert headers match §5.3 exactly and fail fast on mismatch.
- **LP eligibility is data-driven via `eligibleTrainTypes`.** Any of the six `TrainType` values may appear, including `PASSENGER` and `MAIL_EXPRESS`. `LpCategory` is a role label only — it does not gate eligibility. `MEMU` and `DEMU` must never appear in `assistant_loco_pilots.csv:eligibleTrainTypes`; the CSV loader rejects ALP rows that violate this.
- **Soft archive only — never `DELETE`.** Repository implementations expose `archive(id)`, never `delete(id)`. All `list*` calls default to `archivedAt IS NULL`. Bypassing the repo to remove rows from the CSV by hand corrupts the audit trail and is forbidden.
- **Train numbers are unique forever.** The CSV loader rejects two rows with the same `Train.number`, regardless of `archivedAt`. A retired train number does **not** become available for re-use.
- **Window-overlap is a domain rule, not a UI concern.** The `assignCrew` orchestrator must enforce it ([§3.5](#35-window-overlap)) using only **active** assignments returned by `AssignmentRepo`. UI dropdown filtering is a convenience that must agree with this rule, never override it.

## 7. Notes for AI Agents Working on This Repo
- When adding a new train type: update `TrainType` enum → eligibility matrix in `isLpEligible` → `isAlpEligible` (decide if ALPs serve it) → `requiresAlp` → CSV loader validation, in that order.
- When changing the rest window from 16 hours: edit only `MIN_REST_HOURS`. Never search-and-replace the literal `16`.
- LP eligibility is fully **data-driven**: the per-LP `eligibleTrainTypes` list IS the drivable set. `LpCategory` is a role label only and must not be re-introduced into the eligibility decision.
- New rules go in the domain layer first, then surface through the application layer, then the UI. Never the other way around.
- CSV is the system of record. Never read/write `data/*.csv` outside the repository layer. All writes go through the temp-file + rename pattern under the single-writer lock.
