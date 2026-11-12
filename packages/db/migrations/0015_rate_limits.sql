-- Fixed-window counters for limits that apply before anyone is inside a
-- tenant: opening sandboxes, and calls with an API key. Buckets name what
-- is limited (a hashed client address, a key id), never a person. Only the
-- platform connection uses this table; the app role has no access.

CREATE TABLE rate_limits (
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
REVOKE ALL ON rate_limits FROM PUBLIC;
