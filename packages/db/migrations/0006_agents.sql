-- Agents and evals. Every tenant brings its own model; agents stay off
-- until they pass their policy pack's golden set on that model; drafts are
-- stored as notes, so their text is erasable and the audit log keeps only
-- their hash. Tables here hold IDs, codes, counts and ciphertext.

-- One data key per tenant, wrapped by the platform master key. Every secret
-- the tenant stores is encrypted under it; deleting the row makes them all
-- unreadable.
CREATE TABLE tenant_keys (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  kek_id text NOT NULL,
  wrapped_key text NOT NULL,
  created_at timestamptz NOT NULL
);

-- The model a tenant's agents run on. The key is ciphertext; the hint is
-- its last four characters.
CREATE TABLE model_connections (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('scripted', 'openai', 'azure-openai', 'openai-compatible')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  endpoint text CHECK (endpoint ~ '^https?://'),
  api_version text,
  key_ciphertext text,
  key_hint text CHECK (key_hint IS NULL OR length(key_hint) <= 4),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((provider = 'scripted') = (key_ciphertext IS NULL)),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);

-- An agent run against a golden set on one model. Results hold case ids,
-- scores and failure codes, never model output.
CREATE TABLE agent_evals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_id text NOT NULL,
  agent_version text NOT NULL,
  golden_set text NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'passed', 'failed', 'error')),
  error_code text,
  total integer NOT NULL CHECK (total > 0),
  threshold numeric NOT NULL CHECK (threshold > 0 AND threshold <= 1),
  results jsonb NOT NULL DEFAULT '[]',
  score numeric,
  critical_failures integer,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((state = 'running') = (finished_at IS NULL)),
  FOREIGN KEY (tenant_id, started_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, pack_id, pack_version) REFERENCES policy_packs(tenant_id, pack_id, version)
);
CREATE UNIQUE INDEX agent_evals_one_running ON agent_evals (tenant_id, agent_id) WHERE state = 'running';

-- Whether an agent is on, and the passing evaluation that allowed it.
CREATE TABLE agent_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  eval_id uuid,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, agent_id),
  CHECK (NOT enabled OR eval_id IS NOT NULL),
  FOREIGN KEY (tenant_id, eval_id) REFERENCES agent_evals(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);

-- One model call. Codes, ids, counts and tokens only.
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  agent_id text NOT NULL,
  agent_version text NOT NULL,
  fingerprint text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('intake', 'draft', 'eval')),
  requested_by text NOT NULL,
  asset_id uuid,
  case_id uuid,
  review_id uuid,
  eval_id uuid,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed', 'stale')),
  error_code text,
  -- Intake: the suggested yes/no/unsure per field. Drafts: counts. No text.
  result jsonb NOT NULL DEFAULT '{}',
  input_tokens integer,
  output_tokens integer,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES domain_reviews(tenant_id, id),
  FOREIGN KEY (tenant_id, eval_id) REFERENCES agent_evals(tenant_id, id)
);
CREATE INDEX agent_runs_recent_idx ON agent_runs (tenant_id, started_at DESC);

-- The drafter's work on a domain review: queued, ready (the review is
-- drafted), or failed. A new request id per draft keeps a retry from
-- landing on a review someone has since acted on.
ALTER TABLE domain_reviews
  ADD COLUMN draft_status text NOT NULL DEFAULT 'none' CHECK (draft_status IN ('none', 'queued', 'ready', 'failed')),
  ADD COLUMN draft_request_id uuid,
  ADD COLUMN draft_error text,
  -- The draft itself, as JSON in an erasable note.
  ADD COLUMN draft_note_id uuid,
  ADD COLUMN draft_run_id uuid,
  ADD CONSTRAINT domain_reviews_draft_request CHECK ((draft_status = 'queued') <= (draft_request_id IS NOT NULL));
CREATE INDEX domain_reviews_draft_queue ON domain_reviews (draft_status) WHERE draft_status = 'queued';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_keys', 'model_connections', 'agent_evals', 'agent_settings', 'agent_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- A data key is created once and never replaced from inside a tenant.
GRANT SELECT, INSERT ON tenant_keys TO aegis_app;
GRANT SELECT, INSERT, UPDATE ON model_connections, agent_evals, agent_settings, agent_runs TO aegis_app;
