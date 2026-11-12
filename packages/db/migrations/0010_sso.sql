-- Single sign-on. A customer tenant signs its people in through its own
-- OpenID Connect provider; Aegis keeps no passwords. A person is matched by
-- the provider's subject once linked, and by email the first time. Admins
-- can switch a person off, which ends their sessions at the next request.

CREATE TABLE tenant_sso (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- The provider's issuer URL, exactly as its discovery document states it.
  issuer text NOT NULL CHECK (issuer ~ '^https?://'),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
  -- Sealed with the tenant's data key; NULL for public clients (PKCE only).
  client_secret_sealed text,
  -- Only addresses at these domains may sign in. Never empty.
  email_domains text[] NOT NULL CHECK (cardinality(email_domains) > 0),
  -- Roles given to a person who signs in without being added first.
  -- NULL means people must be added by an admin before they can sign in.
  join_roles text[],
  updated_at timestamptz NOT NULL
);

ALTER TABLE tenant_sso ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sso FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_sso
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
-- Configured by the platform (the owner role); the app only reads it.
GRANT SELECT ON tenant_sso TO aegis_app;

-- The provider's subject for a person, set the first time they sign in.
ALTER TABLE users ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX users_sso_subject ON users (tenant_id, sso_subject) WHERE sso_subject IS NOT NULL;
-- Email matching is case-insensitive, so two people cannot differ only by case.
CREATE UNIQUE INDEX users_email_ci ON users (tenant_id, lower(email));

-- A person who is switched off cannot sign in, and their sessions stop working.
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN last_sign_in_at timestamptz;
