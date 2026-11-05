-- SBX migration 0026: which API groups partners may call (INT-CTL, CTL.4). Owned by SBX lane CTL.
-- Forward-only: there is no down step. api_exposure holds one row per group of the API_GROUPS const of
-- packages/contracts (the CHECK below lists the same names; a golden test compares the two). A row is switched, never
-- removed: a missing row would read as an absent decision, so the reader treats it as closed and the triggers
-- below keep every row in place. All rows start enabled, stamped with the epoch like the other seeds, so a restore
-- recognises a fresh database. Who changed a row and when are columns of the row; the journal of INT-TR0 holds the
-- history (the changer only as a sha256).

CREATE TABLE api_exposure (
  group_name text PRIMARY KEY CHECK (group_name IN (
    'catalogue', 'orders', 'library', 'mandates', 'webhooks', 'seller', 'ops', 'mcp',
    'mcp:search_catalogue', 'mcp:get_offer', 'mcp:propose_pack', 'mcp:open_unit', 'mcp:check_budget', 'mcp:buy_unit'
  )),
  enabled boolean NOT NULL,
  changed_by text,
  changed_at timestamptz NOT NULL,
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('incident', 'partner_request', 'maintenance', 'other')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- 2. One row per group, enabled, all three times at the epoch (SEED_EPOCH).
INSERT INTO api_exposure (group_name, enabled, changed_by, changed_at, reason_code, created_at, updated_at)
SELECT g, true, NULL, '1970-01-01T00:00:00Z', NULL, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'
  FROM unnest(ARRAY[
    'catalogue', 'orders', 'library', 'mandates', 'webhooks', 'seller', 'ops', 'mcp',
    'mcp:search_catalogue', 'mcp:get_offer', 'mcp:propose_pack', 'mcp:open_unit', 'mcp:check_budget', 'mcp:buy_unit'
  ]) AS g;

-- 3. A row is never deleted or truncated (ums_deny_delete is 0006's function).
CREATE TRIGGER api_exposure_no_delete BEFORE DELETE ON api_exposure
  FOR EACH ROW EXECUTE FUNCTION ums_deny_delete();
CREATE TRIGGER api_exposure_no_truncate BEFORE TRUNCATE ON api_exposure
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- 4. The journal (TR0, D-097). api_exposure joins trace_tracked by the seed convention of the consolidation
-- (section 2, "Adding a tracked table in a later migration"): 0023 keeps trace_tracked_seed(),
-- trace_tracked_reseed() and its trigger untouched; this migration adds only names that carry its own number.
-- Postgres fires AFTER TRUNCATE triggers in name order, so a reset refills 0023's rows first and then each later
-- migration's. The changer is hashed (R2-1, like safety_switches.changed_by); the reason is a code, copied. The row
-- is changed in place, so it has no frozen digest. It lives on the platform chain.

CREATE FUNCTION trace_tracked_seed_0026() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('api_exposure', ARRAY['enabled', 'changed_at', 'reason_code'], ARRAY['changed_by'], ARRAY[]::text[], 'changed_at', 'plat')
  ;
$fn$;

CREATE FUNCTION trace_tracked_reseed_0026() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM trace_tracked_seed_0026();
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER trace_tracked_reseed_0026 AFTER TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION trace_tracked_reseed_0026();

SELECT trace_tracked_seed_0026();

-- The primary key of a tracked row is one text. Every earlier table has an id, safety_switches has its name, and this
-- one has group_name. The body is 0023's with one more branch (nothing else changes).
CREATE OR REPLACE FUNCTION trace_source_id(tbl text, r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE tbl
    WHEN 'offers' THEN (r ->> 'id') || ':' || (r ->> 'version')
    WHEN 'access_windows' THEN r ->> 'entitlement_id'
    WHEN 'safety_switches' THEN r ->> 'name'
    WHEN 'api_exposure' THEN r ->> 'group_name'
    ELSE r ->> 'id'
  END
$fn$;

-- 5. TR0's capture trigger, attached the same way 0023 attaches it.
CREATE TRIGGER trace_capture_api_exposure AFTER INSERT OR UPDATE ON api_exposure
  FOR EACH ROW EXECUTE FUNCTION trace_capture();

-- 6. The seeds land in the journal as system/backfill api_exposure.imported events. A second call adds nothing.
SELECT trace_backfill();
