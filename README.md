# Aegis AI

Multi-tenant AI governance for healthcare payers: keep a registry of every
AI system, agent, vendor model and member communication; triage risk with
deterministic policy packs; route each review to the right people; and keep
an audit trail no one can quietly edit. Agents draft; people decide.

Aegis succeeds two earlier projects and folds both in:
[Jeeves](https://github.com/roshanis/jeeves) (AI initiative governance) and
Cleared (pre-publication content compliance review).

> **Status: work in progress, phase 0.** The foundation below is tested.
> The plan and the decisions behind it are in [docs/PLAN.md](docs/PLAN.md).

## What exists today

| Package | What it does |
|---|---|
| `packages/domain` | Tenancy types, roles with separation of duties, the registry (assets, their operating lifecycle, and clearance), a declarative lifecycle engine for risk and content review cases, policy-driven triage with plain-language explanations, fast-lane eligibility, and content-review verdicts. Pure TypeScript, no I/O. |
| `packages/frameworks` | Policy packs as versioned data. `healthcare-ai` reproduces Jeeves' triage exactly (tested across all 64 answer combinations); `financial-communications` carries Cleared's starter rubric. |
| `packages/db` | SQL migrations (checksummed, so an applied one can't be edited) with Postgres row-level security on every tenant table, a `withTenant` helper that is the only route to tenant data, and a per-tenant, hash-chained, append-only audit log. |
| `packages/core` | Governance services: tenant provisioning, people, registering assets, opening and submitting cases (triage and fast lane run on submit), decisions, activating and pausing assets, and each asset's history. Every change and its audit event commit together. |

Guarantees covered by tests:

- A tenant cannot read, write, update or delete another tenant's rows, and sees nothing when no tenant is set.
- The application role cannot create tenants or modify audit events.
- Audit tampering that bypasses the database triggers is detected by chain verification.
- Audit events hold IDs, states and hashes, never free text. Deleting a written reason for an erasure request leaves the chain valid.
- AI agents can never move a case; admins cannot approve; nobody can decide a case they submitted; nobody is given two roles that check each other.
- An asset can't be activated or resumed until its latest decided review approved it, and an open incident review blocks it.
- Each asset has at most one open review; a re-review is a new case on the same asset.
- An auditor gets who decided, why, and under which policy version from one call.

## Develop

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test        # all packages; the db tests run Postgres in-process via PGlite
pnpm typecheck
```

No Docker or external services are needed for development.

## License

[Business Source License 1.1](LICENSE). You may read, modify and run Aegis,
including in production to govern your own organization's AI. You may not
use it to offer AI governance or compliance review to others as a commercial
service. This version becomes available under the Apache License 2.0 on
2030-09-24.
