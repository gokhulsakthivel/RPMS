# Railway People Management System (RPMS)

RPMS assigns **Loco Pilots (LP)** and **Assistant Loco Pilots (ALP)** to trains under strict eligibility, rest, and hierarchy rules.

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
| Why can't a Mail Express LP drive a Passenger train?  | [HLD §4.2](./HLD.md#42-lp-eligibility-hierarchy-rule) |
| What's the rest window?                               | [HLD §4.3](./HLD.md#43-rest-rule-16-hours) |
| What are the function signatures I should implement?  | [LLD §3](./LLD.md#3-validation-functions) |
| What error codes do I return?                         | [LLD §4](./LLD.md#4-error-contract) |
| What tests are mandatory?                             | [LLD §7](./LLD.md#7-testing-requirements) |

## Non-Negotiables (for AI Agents)
1. **Domain layer owns the rules.** UI/API never makes rule decisions on its own.
2. **`MIN_REST_HOURS` is the only place** the literal `16` may appear. Do not scatter it.
3. **Roster counts (16/16/29) are configuration**, not code. The workforce can grow.
4. **The hierarchy rule is counter-intuitive on purpose.** Higher-rank Mail Express LP cannot step down to Passenger duty. The comment near `isLpEligible` exists so future contributors don't "fix" it — leave it.
5. **Time is UTC at rest, IST when rendered.** No ambiguous local-time math.
6. **Errors are structured** (`{ code, ...context }`), never raw strings.

## When You Add or Change Things
- **New train type?** Update in this order: `TrainType` enum → eligibility matrix in `isLpEligible` → `requiresAlp` → tests → HLD §4.1/§4.2 tables.
- **Rest window change?** Edit `MIN_REST_HOURS` and HLD §4.3 only.
- **New business rule?** Domain layer first, then application, then UI. Document in HLD; specify the contract in LLD.
