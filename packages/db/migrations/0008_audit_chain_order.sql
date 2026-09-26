-- Keep each tenant's audit chain in id order under concurrent writers.
--
-- An event's id came from its column default, which Postgres evaluates
-- before the chain trigger takes the tenant's lock. A transaction that wrote
-- two events while another waited got ids either side of the waiter's, and
-- the trigger's "latest event" (highest id) was then not the one last
-- chained: two events could name the same predecessor, and verification,
-- which walks the log by id, reported a break nobody made.
--
-- The trigger now takes a fresh id after the lock. The lock is held until
-- the writer commits, so within a tenant ids follow chain order exactly.
-- The hash does not cover the id, so events already written keep theirs.

CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE last text;
  BEGIN
    -- Serialize writers per tenant so the chain never forks.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));
    NEW.id := nextval(pg_get_serial_sequence('audit_events', 'id'));
    SELECT hash INTO last FROM audit_events WHERE tenant_id = NEW.tenant_id ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := last;
    NEW.hash := audit_hash(NEW, last);
    RETURN NEW;
  END $$;

GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_app;
