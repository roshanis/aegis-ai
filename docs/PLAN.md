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

## Decisions (2026-09-24)

1. **First market: healthcare payers.** AI initiative governance plus review
   of member communications, where Cleared's engine applies with a CMS pack.
2. **Workflow engine: DBOS.** Durable workflows on the Postgres every
   deployment already runs, so dedicated and BYOC installs need nothing else.
3. **License: BSL 1.1.** Production use for your own organization is free;
   offering Aegis as a commercial governance service is not. Each release
   converts to Apache 2.0 after its Change Date; move the Change Date
   forward with each release.
4. **`main` is the base branch.** Work lands through pull requests.

## Changes from the first plan (re-review, 2026-09-24)

1. **Registry first** *(done)*. Assets (AI system, agent, vendor model,
   content item) are long-lived records with an operating state: registered,
   active, paused, retired. Reviews are cases attached to an asset; a
   re-review (change, periodic, incident) is a new case on the same asset.
   An asset is cleared for use when its latest decided case approved it and
   no incident review is open.
2. **Postgres-native workflows** with DBOS (decided above).
3. **One wedge**: healthcare payers (decided above).
4. **Evals ship with the first agent.** A golden-set gate blocks any agent
   from customer use until it passes.
5. **Audit rows hold no personal data or document text** *(done)*. Events
   carry IDs, states, codes and the SHA-256 of any written reason; the text
   lives in `notes`, which can be deleted for an erasure request without
   breaking the chain. Per-tenant keys for content come with document
   storage.
6. **Model-provider agnostic.** OpenAI Agents SDK by default behind
   `AgentPort`; Azure OpenAI, Bedrock or a customer endpoint per tenant.
7. **Cut for now:** org/workspace hierarchy, SCIM. **Added:** audited
   support access, tenant provisioning *(done)*, a sandbox tenant per visitor.

## UX targets

- A requester submits in under 10 minutes with no training.
- A reviewer signs a draft from one screen.
- An auditor answers "who approved X, why, under which policy version" in
  under 30 seconds.

## Phases

0. **Walking skeleton** *(done)*. Tenancy and RLS, registry, provisioning,
   intake to triage to case to audit, a sandbox tenant per visitor, the
   console over `@aegis/core`, and CI that runs isolation tests and an
   end-to-end walk of the console in Chromium.
1. **Governance core** *(done)*. Domain reviews (sign, return with a
   question, abstain, resume; revision-checked), decision readiness,
   Jeeves' control catalog, evidence (links and attestations), time-boxed
   control exceptions, decisions with before-use and ongoing conditions,
   and clearance that requires all of it. Jeeves' readiness, abstention,
   exception and applicability tests are ported as acceptance tests.
   Deferred: file uploads (with per-tenant keys), exception renewal,
   evidence re-attestation on each control's cadence, and per-evidence
   assessments.
2. **Agents and evals.** Durable workflows, drafting and intake agents,
   golden-set gate, per-tenant model keys.
3. **Member communications review.** Cleared's engine with a CMS pack.
4. **Differentiators.** Agent and MCP tool inventory, evidence connectors,
   more frameworks, dedicated and BYOC deployment.

## Known gaps

- **No real sign-in yet.** The console knows sandbox sessions only. SSO
  (OIDC/SAML) per tenant comes before the first customer tenant.
- **Sandbox creation is not rate-limited.** Expired sandboxes are purged,
  but nothing stops one visitor opening many.
- **Offboarding a customer tenant** needs a platform command and a retention
  decision. The purge path already exists (sandboxes use it): the audit log
  accepts deletes only for the tenant named in `app.purge_tenant`.
- **Agents have no read access yet**; phase 2 scopes it to the cases they
  draft for, and produces the `drafted` reviews the readiness rules
  already accept.
- **Monitor controls have no due dates yet.** They are tracked but never
  go overdue; cadence-driven re-attestation comes with evidence storage.
- **Owners attest control applicability through their answers.** A
  reviewer sees every control and its evidence before signing, but cannot
  yet mark evidence insufficient without returning the whole review.

Framework references in packs mean "helps evidence", never "certifies
compliance".
