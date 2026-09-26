-- The registry. An asset is the long-lived record of something a tenant
-- governs; cases are the reviews attached to it over time. Notes hold the
-- free text people write when they act (reasons, conditions). Notes can be
-- deleted for an erasure request; the audit log keeps only their hash.

CREATE TABLE assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('ai_system', 'agent', 'vendor_model', 'content_item')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  state text NOT NULL DEFAULT 'registered' CHECK (state IN ('registered', 'active', 'paused', 'retired')),
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX assets_tenant_state_idx ON assets (tenant_id, state);

CREATE TABLE cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('risk_review', 'content_review')),
  trigger text NOT NULL CHECK (trigger IN ('initial', 'change', 'periodic', 'incident')),
  state text NOT NULL,
  owner_id uuid NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}',
  tier text CHECK (tier IN ('low', 'medium', 'high', 'critical')),
  triage jsonb,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Composite keys stop a row pointing at another tenant's asset, user or pack.
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, pack_id, pack_version) REFERENCES policy_packs(tenant_id, pack_id, version)
);
CREATE INDEX cases_asset_idx ON cases (tenant_id, asset_id, created_at);
CREATE INDEX cases_tenant_state_idx ON cases (tenant_id, state);
-- One review at a time per asset.
CREATE UNIQUE INDEX cases_one_open_per_asset ON cases (tenant_id, asset_id) WHERE decided_at IS NULL;

CREATE TABLE notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  case_id uuid,
  author_id text NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id)
);
CREATE INDEX notes_asset_idx ON notes (tenant_id, asset_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets', 'cases', 'notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON assets, cases TO aegis_app;
-- The app never edits a note; it can only delete one to honour an erasure request.
GRANT SELECT, INSERT, DELETE ON notes TO aegis_app;
