-- Case numbers. People say "CASE-0142", not a UUID, so every case gets a
-- number that counts up within its tenant. The database assigns it, under a
-- per-tenant lock, so concurrent intakes never collide and no code path can
-- forget to set it.

ALTER TABLE cases ADD COLUMN number integer;

-- Number existing cases in the order they were opened. Row-level security
-- is forced on cases, so lift it for the backfill inside this transaction.
ALTER TABLE cases NO FORCE ROW LEVEL SECURITY;
UPDATE cases c SET number = n.rn
FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM cases) n
WHERE c.id = n.id;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;

ALTER TABLE cases ALTER COLUMN number SET NOT NULL;
ALTER TABLE cases ADD CONSTRAINT cases_number_positive CHECK (number > 0);
ALTER TABLE cases ADD CONSTRAINT cases_tenant_number_key UNIQUE (tenant_id, number);

CREATE FUNCTION cases_number() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('case-number:' || NEW.tenant_id::text, 0));
    SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM cases WHERE tenant_id = NEW.tenant_id;
    RETURN NEW;
  END $$;

CREATE TRIGGER cases_number BEFORE INSERT ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_number();

-- A number, once given, never changes.
CREATE FUNCTION cases_number_fixed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.number IS DISTINCT FROM OLD.number THEN RAISE EXCEPTION 'a case number cannot change'; END IF;
    RETURN NEW;
  END $$;

CREATE TRIGGER cases_number_fixed BEFORE UPDATE OF number ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_number_fixed();
