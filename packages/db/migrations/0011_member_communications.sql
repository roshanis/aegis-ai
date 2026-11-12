-- Member communications. Each submission of a communication is a version:
-- its text, the markets it is for, and the result of checking it against
-- the case's content pack, all written once and never changed. A request
-- for changes leads to a new version, so the officer's decision always
-- names exactly what they read.

CREATE TABLE content_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  case_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 40000),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  markets text[] NOT NULL CHECK (cardinality(markets) > 0),
  -- The check, run in code against the case's pinned pack when this version was submitted.
  findings jsonb NOT NULL,
  coverage jsonb NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'fail', 'needs_human_review')),
  by_market jsonb NOT NULL,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL,
  UNIQUE (tenant_id, case_id, version),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES users(tenant_id, id)
);

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_versions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- Written once: the app may add versions but never edit or remove one.
GRANT SELECT, INSERT ON content_versions TO aegis_app;
