# Plan

## Principles

- **Agents draft, humans decide.** No agent holds approval authority. Enforced
  in the lifecycle engine, not by convention.
- **Tenant isolation lives in the database.** Row-level security on every
  tenant table; the app role cannot bypass it.
- **Policy is data.** Triage rules, review routing and rubrics ship as
  versioned packs tenants can adopt, fork and diff.
- **One codebase, every deployment mode.** Shared SaaS, dedicated instance,
  and customer cloud (BYOC). Nothing may require a service that cannot run
  next to the customer's Postgres.

## Changes from the first plan (re-review, 2026-09-24)

1. **Registry first.** Separate the long-lived record (AI system, agent,
   vendor model, content item) from the review cases attached to it.
   Jeeves merged the two; the current `initiativeLifecycle` inherits that
   and will be split into an asset operating state (deployed, paused,
   retired) and a review-case state.
2. **Postgres-native workflows.** Prefer DBOS over Inngest so BYOC needs
   only Postgres.
3. **One wedge.** Healthcare payers: AI initiative governance plus review of
   member communications, where Cleared's engine applies with a CMS pack.
4. **Evals ship with the first agent.** A golden-set gate blocks any agent
   from customer use until it passes.
5. **Audit rows hold no personal data or document text.** IDs, states and
   hashes only, so tenant offboarding and erasure requests work with an
   immutable log. Content lives in deletable tables with per-tenant keys.
6. **Model-provider agnostic.** OpenAI Agents SDK by default behind
   `AgentPort`; Azure OpenAI, Bedrock or a customer endpoint per tenant.
7. **Cut for now:** org/workspace hierarchy, SCIM. **Added:** audited
   support access, tenant provisioning, a sandbox tenant per visitor.

## UX targets

- A requester submits in under 10 minutes with no training.
- A reviewer signs a draft from one screen.
- An auditor answers "who approved X, why, under which policy version" in
  under 30 seconds.

## Phases

0. **Walking skeleton.** Tenancy and RLS (done), registry, intake to triage
   to case to audit, sandbox tenant, CI isolation tests.
1. **Governance core.** Reviews, sign-off, decisions with conditions,
   controls, evidence. Jeeves' tests become acceptance tests.
2. **Agents and evals.** Durable workflows, drafting and intake agents,
   golden-set gate, per-tenant model keys.
3. **Member communications review.** Cleared's engine with a CMS pack.
4. **Differentiators.** Agent and MCP tool inventory, evidence connectors,
   more frameworks, dedicated and BYOC deployment.

## Open decisions

1. First market: healthcare payers (recommended)?
2. Workflow engine: DBOS (recommended) or Inngest?
3. License: MIT, AGPL or BSL?

Framework references in packs mean "helps evidence", never "certifies
compliance".
