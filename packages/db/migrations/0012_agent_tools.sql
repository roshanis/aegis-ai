-- What each agent can reach: the tools it may call and the server or
-- integration that provides them. Rows are never deleted: removing a tool
-- stamps it, so the inventory at any past moment can be rebuilt. A tool
-- added after an agent's approving decision keeps it from being cleared
-- until a re-review covers it.

CREATE TABLE agent_tools (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid NOT NULL,
  server text NOT NULL CHECK (length(trim(server)) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  effect text NOT NULL CHECK (effect IN ('read', 'write', 'external')),
  phi boolean NOT NULL,
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL,
  removed_by uuid,
  removed_at timestamptz,
  CHECK ((removed_by IS NULL) = (removed_at IS NULL)),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, added_by) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, removed_by) REFERENCES users(tenant_id, id)
);
-- One live row per tool on an agent.
CREATE UNIQUE INDEX agent_tools_live_idx ON agent_tools (tenant_id, asset_id, server, name) WHERE removed_at IS NULL;
CREATE INDEX agent_tools_asset_idx ON agent_tools (tenant_id, asset_id);

ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_tools
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- Added and removed, never edited or deleted.
GRANT SELECT, INSERT ON agent_tools TO aegis_app;
GRANT UPDATE (removed_by, removed_at) ON agent_tools TO aegis_app;
