-- API keys let a tenant's own tools (CI pipelines, scanners, test
-- harnesses) post evidence to Aegis. Only a hash of each key's secret is
-- kept; the key itself is shown once. A key acts for the admin who made it,
-- and only while that admin is still an active admin, so switching someone
-- off also stops their keys.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  secret_sha256 text NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['evidence:write']),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES users(tenant_id, id)
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- A key's secret and scope never change: revoke it and make another.
GRANT SELECT, INSERT ON api_keys TO aegis_app;
GRANT UPDATE (last_used_at, revoked_by, revoked_at) ON api_keys TO aegis_app;

-- Evidence a tool posted names the key it came through.
ALTER TABLE evidence ADD COLUMN api_key_id uuid;
ALTER TABLE evidence ADD FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys(tenant_id, id);
