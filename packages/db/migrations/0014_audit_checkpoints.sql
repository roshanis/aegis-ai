-- Verified points in each tenant's audit chain. Verifying the whole chain
-- on every audit page view grows with the log; instead each verification
-- starts from the latest checkpoint, after confirming the checkpointed
-- event still carries the hash it had. Exports and an explicit full check
-- still walk the whole chain.

CREATE TABLE audit_checkpoints (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  through_id bigint NOT NULL,
  through_hash text NOT NULL,
  events integer NOT NULL CHECK (events > 0),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, through_id)
);

ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_checkpoints
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON audit_checkpoints TO aegis_app;
