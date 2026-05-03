# Railway People Management System (RPMS) — High-Level Design

## 1. Overview
RPMS is a people management system for Indian Railways that handles the assignment of **Loco Pilots (LP)** and **Assistant Loco Pilots (ALP)** to trains. The system enforces eligibility and rest rules to ensure only qualified crew are scheduled for each train type.

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
