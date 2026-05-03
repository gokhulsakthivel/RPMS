# Railway People Management System (RPMS)

RPMS assigns **Loco Pilots (LP)** and **Assistant Loco Pilots (ALP)** to trains under strict eligibility and rest rules.

## Design Documents
The full design is split across two files. **Read both before changing business logic.**

- **[HLD.md](./HLD.md)** — High-Level Design
  Domain glossary, crew roster, business rules, eligibility matrix, rest rule, assignment workflow, architecture, scope.

- **[LLD.md](./LLD.md)** — Low-Level Design
  Type definitions, domain model, validation function signatures, error contract, repositories, coding standards, test matrix.

## Quick Pointers
| Question                                              | Where to look                          |
|-------------------------------------------------------|----------------------------------------|
| What train types exist and who can drive them?        | [HLD §4.1–4.2](./HLD.md#4-core-business-rules) |
| How is LP eligibility decided?                        | [HLD §4.2](./HLD.md#42-lp-eligibility-data-driven) — `train.type ∈ lp.eligibleTrainTypes` |
| What's the rest window?                               | [HLD §4.3](./HLD.md#43-rest-rule-16-hours) |
| What are the function signatures I should implement?  | [LLD §3](./LLD.md#3-validation-functions) |
| What error codes do I return?                         | [LLD §4](./LLD.md#4-error-contract) |
| What tests are mandatory?                             | [LLD §7](./LLD.md#7-testing-requirements) |

## Non-Negotiables (for AI Agents)
1. **Domain layer owns the rules.** UI/API never makes rule decisions on its own.
2. **`MIN_REST_HOURS` is the only place** the literal `16` may appear. Do not scatter it.
3. **Roster counts (16/16/29) are configuration**, not code. The workforce can grow.
4. **LP eligibility is data-driven.** `lp.eligibleTrainTypes` is the source of truth for every train type — including `PASSENGER` and `MAIL_EXPRESS`. `LpCategory` is a role label only and must not be re-introduced into `isLpEligible`. To grant or revoke eligibility, edit the LP's `eligibleTrainTypes` list.
5. **Time is UTC at rest, IST when rendered.** No ambiguous local-time math.
6. **Errors are structured** (`{ code, ...context }`), never raw strings.

## When You Add or Change Things
- **New train type?** Update in this order: `TrainType` enum → `requiresAlp` → seed any LPs/ALPs that are certified → tests → HLD §4.1/§4.2 tables. (`isLpEligible` itself is a one-liner — it does not need editing per type.)
- **Rest window change?** Edit `MIN_REST_HOURS` and HLD §4.3 only.
- **New business rule?** Domain layer first, then application, then UI. Document in HLD; specify the contract in LLD.
