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
2. **Postgres-native workflows** with DBOS (decided above) *(done for agent
   jobs)*.
3. **One wedge**: healthcare payers (decided above).
4. **Evals ship with the first agent** *(done)*. A golden-set gate blocks
   any agent from use until it passes on the tenant's own model.
5. **Audit rows hold no personal data or document text** *(done)*. Events
   carry IDs, states, codes and the SHA-256 of any written reason; the text
   lives in `notes`, which can be deleted for an erasure request without
   breaking the chain. Per-tenant keys for content come with document
   storage.
6. **Model-provider agnostic** *(done, except Bedrock)*. OpenAI Agents SDK;
   OpenAI, Azure OpenAI or any OpenAI-compatible endpoint per tenant.
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
2. **Agents and evals** *(done)*. The intake assistant suggests intake
   answers the requester checks and submits; the review drafter drafts each
   domain review, which a reviewer signs, edits or ignores. Both run on the
   OpenAI Agents SDK with structured output, no tools, and SDK tracing off.
   An agent may only move a review into "drafted", enforced when a lifecycle
   is defined. Each tenant connects its own model; keys are sealed with a
   per-tenant data key under the platform master key. Golden sets ship in
   the policy pack (`healthcare-ai` 1.2.0 on: 12 intake cases, 9 drafting
   cases), and an agent can be turned on only after it passes on the
   tenant's current model. Drafting and evaluations are DBOS workflows whose
   checkpoints hold IDs and codes only; on PGlite they run in-process.
   A draft is redone when evidence or an exception for one of its domain's
   controls changes. Deferred: Bedrock and Anthropic providers, spend
   limits, and human-graded or model-graded evals.
   **Console on the Aegis design system** *(done)*. Two directions from
   the UI/UX canvas: the Sentence for intake (`healthcare-ai` 1.3.0 words
   its questions as one sentence; rules and golden sets are unchanged, and
   packs without a sentence fall back to questions), and the Table for the
   case page. The front page started as the canvas's Docket and was
   replaced by a visual home (counts, stage and tier bars, what waits for
   you, latest decisions, agent scores, audit status), with explanatory
   copy cut across the screens. Case numbers per tenant, an audit page that
   answers by case number with the event chain, an audited evidence-pack
   export, a policy pack viewer, ⌘K, and a person-chosen theme. Checked in
   dark, light and at phone width.
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
- **Agents read only what they are handed.** The drafter's context is built
  from one case under row-level security; it has no tools and no database
  access. Jeeves' rule still lets a conditional approval rest on drafts
  nobody signed; the decision's audit event lists them.
- **Token controls cover drafts and intake, not evaluations.** A tenant's own
  key pays for every call, so Aegis skips calls whose answer cannot change
  (a repeated intake description, a redraft whose inputs are unchanged),
  waits 20 seconds before a redraft so a burst of evidence costs one call,
  bounds what goes in and comes out of each call, and lets an admin cap
  monthly tokens and each person's daily intake requests. The monthly cap
  is checked before each call, so calls already running can overshoot it
  slightly. Golden-set evaluations are counted but not capped, since an admin
  starts each one. A sandbox visitor can still connect an OpenAI key.
- **Endpoint checks resolve names before each call,** so a public name that
  points at a private address is refused; a resolver that changes its answer
  between the check and the connection is not.
- **The scripted model is tuned to the pack's golden sets.** It shows how the
  gate works; its passing scores say nothing about a real model. The golden
  sets are small (21 cases) and graded in code only.
- **Sandbox seeding runs its agent jobs in-process,** not on DBOS, so a
  sandbox is complete when the visitor lands in it.
- **Monitor controls have no due dates yet.** They are tracked but never
  go overdue; cadence-driven re-attestation comes with evidence storage.
- **The intake sentence's purpose clause stays on the page.** The words a
  requester types about what the system does feed the intake assistant and
  the sentence, but are not saved with the case.
- **Chain verification reads the whole log on each audit or home page view.**
  Fine at sandbox scale; a large tenant needs a checkpointed verifier.
- **Owners attest control applicability through their answers.** A
  reviewer sees every control and its evidence before signing, but cannot
  yet mark evidence insufficient without returning the whole review.

Framework references in packs mean "helps evidence", never "certifies
compliance".
