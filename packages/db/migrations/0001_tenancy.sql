-- Tenancy foundation. Every tenant-owned table carries tenant_id and is
-- protected by row-level security keyed on the transaction-local setting
-- app.tenant_id. The application runs queries as the aegis_app role, which
-- is not the table owner and cannot bypass these policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_app') THEN
    CREATE ROLE aegis_app NOLOGIN;
  END IF;
END $$;

CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  deployment_mode text NOT NULL DEFAULT 'shared' CHECK (deployment_mode IN ('shared', 'dedicated', 'byoc')),
  region text NOT NULL DEFAULT 'us',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  display_name text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  review_domains text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);

CREATE TABLE policy_packs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  pack_id text NOT NULL,
  version text NOT NULL,
  content jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pack_id, version)
);

CREATE TABLE cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('initiative', 'content')),
  title text NOT NULL,
  state text NOT NULL,
  owner_id uuid NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  tier text CHECK (tier IN ('low', 'medium', 'high', 'critical')),
  answers jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Composite keys stop a row pointing at another tenant's user or pack.
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, pack_id, pack_version) REFERENCES policy_packs(tenant_id, pack_id, version)
);
CREATE INDEX cases_tenant_state_idx ON cases (tenant_id, state);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'policy_packs', 'cases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- A tenant can see only its own tenant row, and cannot create or rename tenants.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants FOR SELECT USING (id = current_tenant_id());

GRANT SELECT ON tenants TO aegis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, policy_packs, cases TO aegis_app;
