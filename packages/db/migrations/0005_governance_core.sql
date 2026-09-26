-- Governance core: domain reviews, conditions, evidence and control
-- exceptions. Free text people write (return questions, abstention and
-- exception reasons, condition wording) lives in notes, so erasure works the
-- same way everywhere; these tables hold ids, states and pointers.

-- One review per required domain on a case. The revision increments on
-- every change, so a stale screen cannot overwrite a newer decision.
CREATE TABLE domain_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'drafted', 'signed', 'returned', 'abstained')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reviewer_id uuid,
  -- The latest question, abstention reason or signing memo. No foreign key: notes are erasable.
  note_id uuid,
  -- Conditions the reviewer asks the approver to attach.
  proposed_conditions text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, case_id, domain),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES users(tenant_id, id)
);

-- Conditions attached to a conditional approval.
CREATE TABLE conditions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  case_id uuid NOT NULL,
  note_id uuid NOT NULL,
  due text NOT NULL CHECK (due IN ('before_use', 'ongoing')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'submitted', 'met', 'waived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id)
);
CREATE INDEX conditions_asset_idx ON conditions (tenant_id, asset_id);

-- Evidence for a control on an asset, or for a condition. Links and
-- written attestations for now; file storage arrives with per-tenant keys.
CREATE TABLE evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  control_id text,
  condition_id uuid,
  kind text NOT NULL CHECK (kind IN ('link', 'attestation')),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  url text CHECK (url IS NULL OR url ~ '^https://'),
  detail text,
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL,
  CHECK ((control_id IS NULL) <> (condition_id IS NULL)),
  CHECK ((kind = 'link') = (url IS NOT NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, condition_id) REFERENCES conditions(tenant_id, id),
  FOREIGN KEY (tenant_id, added_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX evidence_asset_idx ON evidence (tenant_id, asset_id);

-- Time-boxed exceptions for gate controls that cannot be met yet.
CREATE TABLE control_exceptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  control_id text NOT NULL,
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'approved', 'rejected', 'revoked', 'expired')),
  requested_by uuid NOT NULL,
  decided_by uuid,
  note_id uuid NOT NULL,
  days integer NOT NULL CHECK (days BETWEEN 1 AND 365),
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'approved') <= (expires_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id)
);
-- At most one live exception (requested or approved) per control on an asset.
CREATE UNIQUE INDEX control_exceptions_one_live
  ON control_exceptions (tenant_id, asset_id, control_id) WHERE state IN ('requested', 'approved');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['domain_reviews', 'conditions', 'evidence', 'control_exceptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON domain_reviews, conditions, control_exceptions TO aegis_app;
-- Evidence is added or withdrawn, never edited in place.
GRANT SELECT, INSERT, DELETE ON evidence TO aegis_app;
