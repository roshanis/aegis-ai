# Aegis AI

Multi-tenant AI governance for healthcare payers: keep a registry of every
AI system, agent, vendor model and member communication; triage risk with
deterministic policy packs; route each review to the right people; and keep
an audit trail no one can quietly edit. Agents draft; people decide.

Aegis succeeds two earlier projects and folds both in:
[Jeeves](https://github.com/roshanis/jeeves) (AI initiative governance) and
Cleared (pre-publication content compliance review).

> **Status: work in progress, phases 0 to 2 built.** The foundation, the governance core, and agents with their evals are tested.
> The plan and the decisions behind it are in [docs/PLAN.md](docs/PLAN.md).

## What exists today

| Package | What it does |
|---|---|
| `packages/domain` | Tenancy types, roles with separation of duties, the registry (assets, their operating lifecycle, and clearance), a declarative lifecycle engine for review cases, domain reviews and decision readiness, controls, conditions and time-boxed exceptions, policy-driven triage with plain-language explanations, fast-lane eligibility, and content-review verdicts. Pure TypeScript, no I/O. |
| `packages/frameworks` | Policy packs as versioned data. `healthcare-ai` reproduces Jeeves' triage exactly (tested across all 64 answer combinations), carries its control catalog, applied identically for every tier and answer combination, and ships the golden sets its agents must pass; `financial-communications` carries Cleared's starter rubric. |
| `packages/agents` | The intake assistant and the review drafter, built on the OpenAI Agents SDK with structured output and no tools. Each tenant brings its own model: OpenAI, Azure OpenAI or any OpenAI-compatible endpoint, plus a scripted stand-in with no AI in it. Output rules (no decision language, no invented controls) are checked in code on every run, and golden-set graders score each agent the same way. |
| `packages/db` | SQL migrations (checksummed, so an applied one can't be edited) with Postgres row-level security on every tenant table, a `withTenant` helper that is the only route to tenant data, and a per-tenant, hash-chained, append-only audit log. |
| `packages/core` | Governance services: tenant provisioning, people, registering assets, opening and submitting cases (triage and fast lane run on submit), domain sign-offs, evidence, control exceptions, decisions with conditions, activating and pausing assets, and each asset's history. Every change and its audit event commit together. Agents: model connections with keys sealed per tenant, the golden-set gate, intake suggestions, and review drafting as workflow steps that hold only IDs. Also sandbox tenants: created per visitor, seeded through the same rules, purged when they expire. |
| `packages/workflows` | Durable agent jobs on DBOS, in the same Postgres. A draft or an evaluation cut off by a crash or a deploy resumes where it stopped, without paying for a finished model call twice. |
| `apps/web` | The console (Next.js). A registry with a "Needs you" queue, one-form registration with live triage and suggested answers, an asset page with the review (and the drafter's drafts), controls and evidence, conditions, and history, and an Agents page for the model, each agent's golden-set results and switch, and recent runs. A visitor opens a private sandbox and switches between requester, two domain reviewers, approver, admin and auditor to see each seat. |

Guarantees covered by tests:

- A tenant cannot read, write, update or delete another tenant's rows, and sees nothing when no tenant is set.
- The application role cannot create tenants or modify audit events.
- Audit tampering that bypasses the database triggers is detected by chain verification.
- Audit events hold IDs, states and hashes, never free text. Deleting a written reason for an erasure request leaves the chain valid.
- AI agents can never move a case; admins cannot approve; nobody can decide a case they submitted; nobody is given two roles that check each other.
- An asset can't be activated or resumed until its latest decided review approved it, and an open incident review blocks it.
- Each asset has at most one open review; a re-review is a new case on the same asset.
- Every required review domain signs off, or abstains with a recorded reason, before an approver can decide. Nobody reviews a case they submitted, and a change made from a stale screen is refused.
- A domain cannot be signed while its gate controls lack evidence or an approved exception.
- Exceptions are time-boxed, and nobody decides one they requested. An expired exception stops covering its control.
- An asset is cleared for use only when its latest decision approved it, its before-use conditions are met, and its gate controls are covered. That holds for fast-laned assets too.
- An auditor gets who decided, why, and under which policy version from one call, and on one screen.
- Sessions are signed: editing the cookie to become someone else signs you out. Switching people is possible only inside a live sandbox.
- An agent may only move a domain review into "drafted". The lifecycle engine refuses, when a lifecycle is defined, any rule that lets an agent into a state that is not a draft state, and no case, asset, exception or condition rule admits one.
- An agent stays off until it passes its policy pack's golden set on the tenant's current model and an admin turns it on. A different model or endpoint turns it off; a new key for the same model does not.
- The golden-set gate fails any intake assistant whose suggestions would have under-triaged a case, and any drafter that states a decision, cites a control the case lacks, misses a bare gate control, or repeats instructions planted in evidence.
- A draft that states a decision or invents a control is discarded before anyone sees it. A person who acts on a review first wins over a draft still in flight.
- The audit log records how each signature used the draft (kept, edited or not used), how many suggested intake answers the requester kept, and which unsigned drafts a conditional approval rested on.
- Model keys are sealed with a per-tenant data key under the platform master key. A ciphertext copied into another tenant, or read for another purpose, does not open. Endpoints on private or internal addresses are refused.
- Workflow checkpoints hold IDs and codes only: no system names or draft text reach DBOS's tables. An evaluation killed mid-run resumes without re-running finished cases.
- The end-to-end tests walk the console in Chromium on every push, on PGlite and on Postgres with DBOS: intake with suggested answers, drafts, sign-off from a draft, decision, activation, audit, and an admin controlling the agents.

## Develop

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test        # all packages; the db tests run Postgres in-process via PGlite
pnpm typecheck
pnpm dev         # the console on http://localhost:3000, on a local PGlite database
pnpm --filter @aegis/web e2e   # build, start, and walk the console in Chromium
```

No Docker or external services are needed for development. On PGlite, agent
jobs run in-process; the sandbox's agents use the scripted model, so nothing
leaves your machine. The DBOS tests need a real Postgres and are skipped
without one:

```sh
AEGIS_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aegis_e2e pnpm --filter @aegis/web e2e
```

### Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres for shared, dedicated or customer-hosted deployments. Connect as the owner role, which must be a member of `aegis_app` and bypass row-level security for provisioning. Agent jobs then run on DBOS, which keeps its tables in a `dbos` schema of the same database. Without it, the console uses PGlite. |
| `AEGIS_SESSION_SECRET` | 32+ random characters for signing sessions. Required in production. |
| `AEGIS_MASTER_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Wraps each tenant's data key, which seals model keys. Required in production; development uses a fixed, public key. `AEGIS_MASTER_KEY_PREVIOUS` keeps an old key readable while you rotate. |
| `AEGIS_ALLOW_PRIVATE_MODEL_ENDPOINTS` | `1` lets model endpoints use http and private addresses, for a model server on your own network. Off by default. |
| `AEGIS_PGLITE_DIR` | Where the local PGlite database lives. Default `.data/pglite`. |

`pnpm dev` and `pnpm start` apply pending migrations before the server starts.

## License

[Business Source License 1.1](LICENSE). You may read, modify and run Aegis,
including in production to govern your own organization's AI. You may not
use it to offer AI governance or compliance review to others as a commercial
service. This version becomes available under the Apache License 2.0 on
2030-09-24.
