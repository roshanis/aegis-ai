-- Append-only, hash-chained audit log. Each tenant has its own chain: an
-- event's hash covers its content and the previous event's hash, so any
-- edit or deletion made outside the application (for example by a DBA)
-- breaks verification from that point on.
--
-- Audit rows hold IDs, states, codes and hashes, never personal data or
-- free text. A reason someone wrote lives in notes; the event keeps the
-- note's id and SHA-256, so deleting the note for an erasure request leaves
-- the chain intact and still proves what was said if the text is produced.

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id uuid,
  case_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'system', 'agent')),
  actor_id text NOT NULL,
  action text NOT NULL,
  before_state text,
  after_state text,
  -- No foreign key: notes are deletable, audit events are not.
  note_id uuid,
  note_sha256 text CHECK (note_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  CHECK ((note_id IS NULL) = (note_sha256 IS NULL)),
  CHECK (case_id IS NULL OR asset_id IS NOT NULL),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cases(tenant_id, id)
);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, id);
CREATE INDEX audit_events_asset_idx ON audit_events (tenant_id, asset_id, id);

CREATE FUNCTION audit_hash(e audit_events, prev text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT encode(sha256(convert_to(concat_ws('|',
      coalesce(prev, ''),
      e.tenant_id::text,
      coalesce(e.asset_id::text, ''),
      coalesce(e.case_id::text, ''),
      e.actor_kind,
      e.actor_id,
      e.action,
      coalesce(e.before_state, ''),
      coalesce(e.after_state, ''),
      coalesce(e.note_id::text, ''),
      coalesce(e.note_sha256, ''),
      e.payload::text,
      to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ), 'UTF8')), 'hex')
  $$;

CREATE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE last text;
  BEGIN
    -- Serialize writers per tenant so the chain never forks.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
    SELECT hash INTO last FROM audit_events WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := last;
    NEW.hash := audit_hash(NEW, last);
    RETURN NEW;
  END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE FUNCTION audit_events_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON audit_events TO aegis_app;
