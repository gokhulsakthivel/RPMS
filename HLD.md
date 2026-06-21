# Railway People Management System (RPMS) — High-Level Design

## 1. Overview
RPMS is a people management system for Indian Railways that handles the assignment of **Loco Pilots (LP)** and **Assistant Loco Pilots (ALP)** to trains. The system enforces eligibility and rest rules to ensure only qualified crew are scheduled for each train type.

The system also models **Links** — predefined multi-day duty rotations published by the divisional running staff office (e.g., *CBE MAIL LINK – 19 MEN*, *CBE-8 MEN PASSENGER LINK*). A Link captures a fixed cycle of positions; each crew member sits at a known position on a given calendar date and advances by one each day. Links exist alongside ad-hoc assignments — they are a **planning aid**, not a replacement for the assignment workflow.

The HLD captures the **what** and **why** — the domain, business rules, workflows, and scope. For the **how** (data models, function signatures, error contracts, tests), see [`LLD.md`](./LLD.md).

## 2. Domain Glossary
- **LP (Loco Pilot)**: The primary driver of a train. Two role categories exist:
  - **Mail Express LP**
  - **Passenger LP**
  > `category` is a **role label** — it does not gate eligibility. Eligibility is fully data-driven via `eligibleTrainTypes` (see §4.2).
- **ALP (Assistant Loco Pilot)**: Assists the LP. Required on most trains, but **NOT** on MEMU and DEMU.
- **Train Types**: `Passenger`, `MEMU` (Mainline Electric Multiple Unit), `DEMU` (Diesel Electric Multiple Unit), `Mail Express`, `Vande Bharat`, `Amrit Bharat`.
- **Sign-On**: When the crew goes on duty — the onward train's `departureTime`.
- **Sign-Off**: When the crew returns to origin and goes off duty — the train's `inwardArrivalTime`. **The 16-hour rest clock starts here.**
- **Rest Window**: Mandatory 16-hour rest between **sign-off** of the previous duty and **sign-on** of the next.
- **Link**: A named, fixed-length rotation cycle published by the running-staff office. A link of length *N* has *N* numbered positions; each position is one calendar day in the rotation. Crew members are placed on a link via a **LinkMembership** that anchors them at a specific position on a specific date — from there the position advances by one (mod N) per day. Real examples: *CBE MAIL LINK – 19 MEN* (cycle length 19), *CBE-8 MEN PASSENGER LINK* (cycle length 8).
- **Link Position Kind**: `DUTY` (one tour of duty composed of one or more train segments), `OFF` (a single off day), `PR` (Periodic Rest — the long weekly rest block).
- **Link Segment**: A single train run inside a `DUTY` position, captured as `(trainNumber, signOnTimeOfDay, signOffTimeOfDay, signOffDayOffset)`. Multiple segments inside the same position represent back-to-back trains worked as one continuous tour.

## 3. Crew Roster (Initial Capacity)
| Role | Category     | Count |
|------|--------------|-------|
| LP   | Mail Express | 16    |
| LP   | Passenger    | 16    |
| ALP  | —            | 29    |

> Roster counts are **not** hardcoded in business logic — they are loaded from configuration so the workforce can grow over time.

## 4. Core Business Rules

### 4.1 Crew Composition by Train Type
| Train Type      | LP Required | ALP Required |
|-----------------|-------------|--------------|
| Passenger       | Yes         | Yes          |
| Mail Express    | Yes         | Yes          |
| Vande Bharat    | Yes         | Yes          |
| Amrit Bharat    | Yes         | Yes          |
| MEMU            | Yes         | **No**       |
| DEMU            | Yes         | **No**       |

### 4.2 LP Eligibility (Data-Driven)
An LP is eligible to drive a train iff the train's type appears in the LP's `eligibleTrainTypes` list. There is **no implicit hierarchy** — every drivable train type is listed explicitly per LP.

| Train Type    | LP eligible?                |
|---------------|-----------------------------|
| Passenger     | If in `eligibleTrainTypes`  |
| Mail Express  | If in `eligibleTrainTypes`  |
| MEMU          | If in `eligibleTrainTypes`  |
| DEMU          | If in `eligibleTrainTypes`  |
| Vande Bharat  | If in `eligibleTrainTypes`  |
| Amrit Bharat  | If in `eligibleTrainTypes`  |

> `LpCategory` (`MAIL_EXPRESS` / `PASSENGER`) is retained as a **role label** for the UI and analytics; it does **not** participate in the eligibility decision. To grant or revoke eligibility for any train type — including `Passenger` and `Mail Express` — edit `eligibleTrainTypes`. The single source of truth is `isLpEligible`.

### 4.3 Rest Rule (16 hours)
A crew member (LP or ALP) is **only assignable** if:
```
trainDepartureTime - lastSignOffTime >= 16 hours
```
- `lastSignOffTime` is the time the crew member returned to origin after their most recent duty (i.e., the previous train's `inwardArrivalTime`).
- Brand-new crew with no prior duty are immediately assignable.

### 4.4 Train Time Endpoints
- Each train stores **both** scheduled endpoints of the duty cycle:
  - `departureTime` — onward sign-on at origin.
  - `inwardArrivalTime` — return sign-off back at origin (after the inward leg).
- On a successful assignment, the train's `inwardArrivalTime` is recorded as the crew's `lastSignOffTime`.
- The inward train number and stations (`inwardTrainNumber`, `inwardFromStation`, `inwardToStation`) are **display-only** — no rule reads them.

### 4.5 ALP Assignment
- ALPs are not arranged in a hierarchy; instead each ALP carries an `eligibleTrainTypes` list of specific certifications.
- An ALP is eligible for a train iff `train.type` ∈ `alp.eligibleTrainTypes`.
- ALPs respect the same 16-hour rest rule (anchored on `lastSignOffTime`).
- ALPs are **never** assigned to MEMU or DEMU. Those values must not appear in any ALP's `eligibleTrainTypes`.

### 4.6 Window-Overlap Rule (No Double-Booking)
- A crew member must not hold two assignments whose duty windows overlap.
- A duty window is `[departureTime, signOffTime]` (closed on both ends — the sign-off instant is still "on duty").
- During the assign workflow, eligible crew are additionally filtered out if any **active (non-archived)** assignment of theirs has a window that overlaps the candidate train's window.
- The 16-hour rest rule covers the back-to-back case for sequential trips (since `lastSignOffTime` advances on each assignment), so this rule mainly catches **same-day overlapping** windows that the rest rule alone would not.

### 4.7 Sign-Off Time Maintenance
- `lastSignOffTime` is set automatically when an assignment is created (to the train's `inwardArrivalTime`).
- It can also be **overridden manually** via the Edit Crew flow — for example, if the operator records a special trip not captured in the system, or wants to gate a crew member out of immediate availability.
- Once set, an assignment never reverts a crew member's `lastSignOffTime`. Archiving an assignment does **not** rewind the clock; the operator may use a manual Edit if they need to roll the time back.

### 4.8 Soft Archive (No Hard Deletes)
- The system **never deletes** entity rows. Train, LP, ALP, and Assignment all support a soft-archive via an `archivedAt` timestamp.
- Archived rows are excluded from default lists, dropdowns, and summary counts. They remain in the CSV and can be surfaced via an explicit "Archived" filter.
- Archiving a Train or crew member does **not** cascade to their past assignments — historical assignments remain visible in the audit trail.
- Active business rules (eligibility, rest, window-overlap) only consider non-archived rows.

### 4.9 Links (Predefined Duty Rotations)
A **Link** captures a published duty rotation — a fixed sequence of positions that together form one repeating cycle. The CBE Mail Link (19 men, 19 positions) and the CBE-8 MEN Passenger Link (8 men, 8 positions) are concrete examples.

- A Link has: `name`, `crewRole` (`LP` or `ALP`), an optional `lpCategory` label (only when `crewRole = LP`), `cycleLength`, and an ordered list of `positions` of length exactly `cycleLength`.
- Each **position** is one of three kinds:
  - **`DUTY`** — one continuous tour of duty made of one or more `segments`. Each segment is a single train run with its own IST `signOnTimeOfDay`, `signOffTimeOfDay`, and `signOffDayOffset` (0 = same IST day, 1 = next IST day, …). When a position has multiple segments the crew chains them with only **out-station rest** between segments — see §4.11.
  - **`OFF`** — a single calendar day off. No duty, no formal rest accounting.
  - **`PR`** — Periodic Rest. A long rest block that explicitly satisfies §4.3 between the surrounding duty positions.
- Links are **schemas**, not assignments. Putting a Link into the system never moves crew or modifies the assignments table on its own. Operators must still run the assignment workflow (or, in a later phase, the Auto-Draft action) for a specific calendar date.
- Links support soft-archive (§4.8) — an archived Link is no longer offered for new memberships and is excluded from Auto-Draft, but its historical records remain readable.

### 4.10 Link Membership (Per-Crew Anchor)
A **LinkMembership** places one crew member on one Link.

- A membership stores `(linkId, crewId, crewRole, anchorDate, anchorPositionNumber)`. From this single anchor the crew member's position on **any** calendar date is deterministic:
  ```
  daysOffset      = istCalendarDays(runDate) - istCalendarDays(anchorDate)
  positionOnDate  = ((anchorPositionNumber - 1 + daysOffset) mod cycleLength) + 1
  ```
- A given crew member SHOULD have at most one active membership at a time. The system does not currently *enforce* uniqueness (operators may temporarily double-up while moving someone between links), but the UI surfaces a warning when two active memberships exist for the same crew.
- `crewRole` on the membership must equal the parent Link's `crewRole`. The CSV loader rejects rows that violate this invariant.
- Memberships use soft-archive. Archiving a membership leaves the audit trail intact; it does not retroactively remove past assignments.
- Archiving a Link or its referenced crew (LP/ALP) does not automatically archive memberships, but read paths exclude memberships whose link or crew is archived. Operators clean up via the Links tab.

### 4.11 Link-Aware Rest Exception (Same-Position Chain)
Real-world links (e.g., position 11 of the CBE Mail Link — train 20642 followed by 20643 with only 8h 55m of out-station rest at ED) deliberately chain multiple short trains inside a single duty tour. The rest gap **between segments of the same position** is shorter than `MIN_REST_HOURS` by design.

- Within a single `DUTY` position, the segments are treated as **one continuous tour**. The 16-hour rest rule (§4.3) is **NOT** applied between segments of the same position.
- The rest rule **IS** still applied between two consecutive duty *positions* — i.e., between the sign-off of the last segment of position *N* and the sign-on of the first segment of position *N+1*. By construction, every published link satisfies this.
- This exception is invoked only by the **Auto-Draft** orchestrator (added in Phase 3) and only for assignments that are part of a Link's same-position chain. **Ad-hoc assignments via the existing Assign Crew workflow continue to enforce §4.3 in full.** The exception is not a back door.
- `MIN_REST_HOURS` itself does not change. The exception is implemented at the **caller** (auto-draft) level by skipping the rest check for known same-position segments — the constant remains the only place the literal `16` appears in the code.

## 5. Assignment Workflow
1. Operator selects a train. The train carries both `departureTime` and `inwardArrivalTime`. Archived trains are not selectable.
2. System reads `inwardArrivalTime` from the train (no computation needed).
3. System filters the LP pool (active, non-archived) by:
   - Eligibility for the train type (`train.type ∈ lp.eligibleTrainTypes`).
   - Rest rule: `train.departureTime - lp.lastSignOffTime >= 16h`.
   - Window-overlap rule (§4.6): no active assignment with an overlapping `[departureTime, signOffTime]` window.
4. If the train requires an ALP, system filters the ALP pool (active, non-archived) by:
   - Eligibility: `train.type ∈ alp.eligibleTrainTypes`.
   - Rest rule: `train.departureTime - alp.lastSignOffTime >= 16h`.
   - Window-overlap rule (§4.6).
5. Operator confirms the assignment. System records `(crewId, trainId, departureTime, signOffTime)` and updates each crew member's `lastSignOffTime` to the train's `inwardArrivalTime`.
6. System rejects assignments that violate any rule and surfaces the specific reason.

```
┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐
│ Select Train │ → │ Read sign-on / off  │ → │ Filter LP Pool      │
└──────────────┘   │ from train row      │   │ (eligibility+rest)  │
                   └────────────────────┘   └─────────┬──────────┘
                                                      │
                                       ┌──────────────▼──────────────┐
                                       │ ALP required?                │
                                       │  Yes → filter ALP by         │
                                       │        eligibility + rest    │
                                       │  No  → skip                  │
                                       └──────────────┬──────────────┘
                                                      │
                                            ┌─────────▼─────────┐
                                            │ Persist Assignment │
                                            │ + update sign-off  │
                                            └────────────────────┘
```

## 6. High-Level Architecture

```
┌─────────────────────┐
│  UI / API Layer     │  ← validates input shape, presents errors
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Application Layer  │  ← orchestrates assignCrew workflow
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Domain Layer       │  ← LP/ALP/Train/Assignment, invariants
│  (rules + entities) │     (eligibility, rest, window-overlap)
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Persistence Layer  │  ← CSV-backed repositories (see LLD §5)
└─────────────────────┘
```

The **Domain Layer** is the source of truth for all business rules. The UI must never make rule decisions on its own.

Persistence is **CSV-backed**, repo-local under `data/`. The four files (`trains.csv`, `loco_pilots.csv`, `assistant_loco_pilots.csv`, `assignments.csv`) are the system of record. Rewrites are atomic (temp file + rename) and serialized through a single-writer lock. Schema details and column contracts live in [LLD §5](./LLD.md#5-persistence).

## 7. Out of Scope (Initial Version)
- Real-time GPS arrival tracking (we use the train's scheduled `inwardArrivalTime`).
- Payroll, leave management, medical fitness tracking.
- Multi-leg / relay crew changes mid-route.
- Crew leave/sick day workflows.
- Notifications / SMS dispatch to crew.

## 8. Phased Delivery — Links
The Links feature ships in phases so each slice is independently shippable:

1. **Phase 1 (shipped)** — Link CRUD, position editor, membership management. **No** impact on the existing Assign Crew workflow. Persistence uses two new CSV files (`links.csv`, `link_memberships.csv`).
2. **Phase 2 (shipped)** — Projection endpoint `GET /api/links/projection?date=YYYY-MM-DD` that returns each active membership's resolved position on the given date (including DUTY segments). Surfaced as a "Today's plan" panel on the Links tab and a Link column on the Crew tab.
3. **Phase 3 (shipped)** — "Auto-Draft from links" toolbar action on the Assignments tab. For each train running on the selected `runDate`, the orchestrator looks up the membership currently at the matching DUTY position and stages a draft assignment after running the standard eligibility / leave / window-overlap checks. Trains already assigned or already drafted are skipped (no overwrite). Amrit Bharat (2-ALP) trains are not auto-drafted in this phase. Operators commit the draft cart through the existing `+ Assign` flow — the system never silently mutates live assignments. The §4.11 link-aware rest exception is structurally accommodated by the orchestrator but currently inert because `assignCrew` does not enforce rest at present.
4. **Phase 4 (shipped)** — Link-suggested defaults inside `AssignCrewModal` (auto-fill on a fresh draft when the suggested crew is eligible, with an info banner crediting the source link) and `EditAssignmentModal` (non-destructive: shows a banner with an explicit "Apply suggestion" button when the link roster suggests different crew than what's currently picked). Suggestions are derived client-side from the Phase 2 projection endpoint; ineligible / on-leave / conflicted crew are never pre-filled.

The phased plan is recorded so future agents can pick up where the previous left off without re-deriving the design.
