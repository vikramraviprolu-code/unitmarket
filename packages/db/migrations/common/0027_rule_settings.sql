-- SBX migration 0027: rule settings (BR-2, D-096). Owned by SBX lane BR-2.
-- Forward-only: there is no down step. Adds one table and its place in the transaction journal; nothing else
-- changes (no existing table, no seed). No existing caller reads the rows: the resolver of BR-1 is the only
-- consumer, and BR-3 and BR-4 are the lanes that will call it.
--
-- rule_settings: one override of a business rule (refund window, access window, mandate length) for the
-- platform, a category, a seller (publishers.id), a buyer (buyers.id) or an agreement. Append-only: a change is
-- a new row with a later effective_from, and the old row stays. No defaults: every business column is given by
-- the caller, every time from the caller's clock. The value range is the registry's (domain/rules checks it);
-- the CHECKs here hold what no registry change can loosen. scope_id has no foreign key because it points at
-- different tables by scope_kind; the write path checks it. The 'agreement' kind is stored for BR-7 and the
-- resolver ignores it until then.
CREATE TABLE rule_settings (
  id ums_id PRIMARY KEY,
  rule_key text NOT NULL CHECK (char_length(rule_key) BETWEEN 1 AND 100),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'category', 'seller', 'buyer', 'agreement')),
  scope_id ums_id,
  value integer NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  set_by ums_id NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  approved_by ums_id,
  created_at timestamptz NOT NULL,
  CHECK ((scope_kind = 'platform') = (scope_id IS NULL)),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX rule_settings_lookup_idx ON rule_settings (rule_key, scope_kind, scope_id, effective_from);
CREATE TRIGGER rule_settings_append_only BEFORE UPDATE OR DELETE ON rule_settings
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER rule_settings_no_truncate BEFORE TRUNCATE ON rule_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- The journal (TR0, D-097). rule_settings joins trace_tracked: its own function holds the lane's row, and the
-- seed function that a reset runs again is wrapped so that it keeps the rows of every earlier migration and
-- adds this one. (A later lane wraps the same way; the order of the lanes does not matter.) The capture
-- trigger is attached the same way 0023 attaches it.

CREATE FUNCTION trace_tracked_seed_br2() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('rule_settings', ARRAY['rule_key', 'scope_kind', 'scope_id', 'value', 'effective_from', 'effective_until', 'set_by'], ARRAY['reason'], ARRAY['id', 'rule_key', 'scope_kind', 'scope_id', 'value', 'effective_from', 'effective_until', 'set_by', 'reason', 'approved_by', 'created_at'], 'created_at', 'plat')
  ;
$fn$;

ALTER FUNCTION trace_tracked_seed() RENAME TO trace_tracked_seed_0023;
CREATE FUNCTION trace_tracked_seed() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM trace_tracked_seed_0023();
  PERFORM trace_tracked_seed_br2();
END;
$fn$;

SELECT trace_tracked_seed_br2();

CREATE TRIGGER trace_capture_rule_settings AFTER INSERT OR UPDATE ON rule_settings
  FOR EACH ROW EXECUTE FUNCTION trace_capture();
