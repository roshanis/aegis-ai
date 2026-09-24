# Aegis AI

Multi-tenant AI governance: register AI systems, triage their risk with
deterministic policy packs, route them to the right reviews, and keep an
audit trail no one can quietly edit. Agents draft; people decide.

Aegis succeeds two earlier projects and folds both in:
[Jeeves](https://github.com/roshanis/jeeves) (AI initiative governance) and
Cleared (pre-publication content compliance review).

> **Status: work in progress, phase 0.** The foundation below is tested.
> Open decisions are listed in [docs/PLAN.md](docs/PLAN.md), including the
> license. No license has been chosen yet, so all rights are reserved.

## What exists today

| Package | What it does |
|---|---|
| `packages/domain` | Tenancy types, roles with separation of duties, a declarative lifecycle engine (AI initiatives and content reviews), policy-driven triage with plain-language explanations, fast-lane eligibility, and content-review verdicts. Pure TypeScript, no I/O. |
| `packages/frameworks` | Policy packs as versioned data. `healthcare-ai` reproduces Jeeves' triage exactly (tested across all 64 answer combinations); `financial-communications` carries Cleared's starter rubric. |
| `packages/db` | SQL migrations with Postgres row-level security on every tenant table, a `withTenant` helper that is the only route to tenant data, and a per-tenant, hash-chained, append-only audit log. |

Guarantees covered by tests:

- A tenant cannot read, write, update or delete another tenant's rows, and sees nothing when no tenant is set.
- The application role cannot create tenants or modify audit events.
- Audit tampering that bypasses the database triggers is detected by chain verification.
- AI agents can never move a case; admins cannot approve; nobody can decide a case they submitted.

## Develop

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test        # all packages; the db tests run Postgres in-process via PGlite
pnpm typecheck
```

No Docker or external services are needed for development.
