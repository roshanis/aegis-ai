-- Sandbox tenants, tenant purging, and job titles.
--
-- A sandbox is an ordinary tenant with an expiry, seeded with demo data for
-- one visitor. Expired sandboxes are purged completely, audit log included.
-- The audit log stays append-only for everyone else: the app role has no
-- DELETE grant, and the owner role may delete only the rows of the one
-- tenant named in app.purge_tenant for the current transaction. Tenant
-- offboarding will use the same path.

ALTER TABLE tenants ADD COLUMN sandbox_expires_at timestamptz;
ALTER TABLE users ADD COLUMN title text;
CREATE INDEX tenants_sandbox_expiry_idx ON tenants (sandbox_expires_at) WHERE sandbox_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.tenant_id::text = current_setting('app.purge_tenant', true) THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only';
  END $$;
