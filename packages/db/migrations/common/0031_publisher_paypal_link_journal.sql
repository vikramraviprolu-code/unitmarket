-- SBX migration 0031: the publisher's PayPal address joins the transaction journal (TR-LINK). Owned by SBX lane TR-LINK.
-- Forward-only: there is no down step. Adds no table and no column; it changes nothing the app reads or writes.
-- publisher_paypal_links (0028) holds the address a publisher is paid to and its operator check. Until now only the
-- app's own audit rows (masked address) said who changed it; a direct SQL change left no event. From here every
-- insert or update writes one trace_events row in the same transaction, with the actor, channel, time and mfa flag of
-- the context. The state and the operator check (verified_by, verified_at) are copied; the address is journaled only
-- as a sha256 (hashed column, never the clear text, so the journal carries no email). The table is changed in place,
-- so it has no frozen digest. Its time column is updated_at, and it lives on the chain of its publisher (pub:<id>).
-- It joins trace_tracked by the seed convention of the consolidation (section 2, "Adding a tracked table in a later
-- migration"): 0023 keeps trace_tracked_seed(), trace_tracked_reseed() and its trigger untouched; this migration adds
-- only names that carry its own number. Postgres fires AFTER TRUNCATE triggers in name order, so a reset refills
-- 0023's rows first and then each later migration's. Rows that exist when this runs are journaled once by
-- trace_backfill() at the end, as system on the backfill channel.

CREATE FUNCTION trace_tracked_seed_0031() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('publisher_paypal_links', ARRAY['state', 'verified_by', 'verified_at'], ARRAY['paypal_email'], ARRAY[]::text[], 'updated_at', 'pub:publisher_id')
  ;
$fn$;

CREATE FUNCTION trace_tracked_reseed_0031() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM trace_tracked_seed_0031();
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER trace_tracked_reseed_0031 AFTER TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION trace_tracked_reseed_0031();

SELECT trace_tracked_seed_0031();

-- The primary key of a tracked row is one text. This table's is publisher_id. The body is 0026's with one more branch
-- (nothing else changes).
CREATE OR REPLACE FUNCTION trace_source_id(tbl text, r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE tbl
    WHEN 'offers' THEN (r ->> 'id') || ':' || (r ->> 'version')
    WHEN 'access_windows' THEN r ->> 'entitlement_id'
    WHEN 'safety_switches' THEN r ->> 'name'
    WHEN 'api_exposure' THEN r ->> 'group_name'
    WHEN 'publisher_paypal_links' THEN r ->> 'publisher_id'
    ELSE r ->> 'id'
  END
$fn$;

-- The chain of a link event is the chain of its publisher. The body is 0025's with two more mentions of the table (the
-- subject key and the chain list); every other branch is unchanged.
CREATE OR REPLACE FUNCTION trace_subject(tbl text, r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  ord text; uni text; mref text; pub text; buy text; chain text; res jsonb;
BEGIN
  CASE tbl
    WHEN 'publishers' THEN pub := r ->> 'id';
    WHEN 'offers' THEN pub := r ->> 'publisher_id';
    WHEN 'publisher_applicant_decisions' THEN pub := r ->> 'publisher_id';
    WHEN 'publisher_paypal_links' THEN pub := r ->> 'publisher_id';
    WHEN 'payee_decisions' THEN
      SELECT publisher_id INTO pub FROM payee_change_requests WHERE id = r ->> 'request_id';
    WHEN 'approvals' THEN buy := r ->> 'buyer_id'; chain := 'buy:' || (r ->> 'buyer_id');
    WHEN 'orders' THEN ord := r ->> 'id'; buy := r ->> 'buyer_id';
    WHEN 'provider_orders' THEN ord := r ->> 'order_id';
    WHEN 'order_units' THEN ord := r ->> 'order_id'; uni := r ->> 'id'; pub := r ->> 'publisher_id';
    WHEN 'operations' THEN ord := r ->> 'order_id'; uni := r ->> 'unit_id';
    WHEN 'provider_calls' THEN
      SELECT order_id INTO ord FROM operations WHERE id = r ->> 'operation_id';
    WHEN 'webhook_events' THEN
      res := r -> 'resource';
      IF res ->> 'provider_order_id' IS NOT NULL THEN
        SELECT order_id INTO ord FROM provider_orders WHERE provider_order_id = res ->> 'provider_order_id' LIMIT 1;
      END IF;
      IF ord IS NULL AND res ->> 'capture_id' IS NOT NULL THEN
        SELECT order_id INTO ord FROM order_units WHERE capture_id = res ->> 'capture_id' LIMIT 1;
      END IF;
      IF ord IS NULL AND res ->> 'refund_id' IS NOT NULL THEN
        SELECT u.order_id INTO ord FROM refund_requests f JOIN order_units u ON u.id = f.unit_id
         WHERE f.refund_id = res ->> 'refund_id' LIMIT 1;
      END IF;
    WHEN 'refund_requests', 'ledger_entries' THEN
      uni := r ->> 'unit_id'; ord := trace_order_of_unit(uni);
    WHEN 'receipts' THEN ord := r ->> 'order_id';
    WHEN 'entitlements' THEN
      uni := r ->> 'unit_id'; ord := trace_order_of_unit(uni); buy := r ->> 'buyer_id';
    WHEN 'access_windows', 'links', 'access_events' THEN
      ord := trace_order_of_entitlement(r ->> 'entitlement_id');
    WHEN 'recovery_cases' THEN ord := r ->> 'order_id'; buy := r ->> 'buyer_id';
    WHEN 'recovery_actions' THEN
      SELECT order_id INTO ord FROM recovery_cases WHERE id = r ->> 'case_id';
    WHEN 'alerts' THEN
      uni := r ->> 'unit_id'; ord := coalesce(r ->> 'order_id', trace_order_of_unit(uni));
    WHEN 'alert_events' THEN
      SELECT coalesce(a.order_id, trace_order_of_unit(a.unit_id)) INTO ord FROM alerts a WHERE a.id = r ->> 'alert_id';
    WHEN 'mandates' THEN mref := r ->> 'id'; buy := r ->> 'buyer_id'; chain := 'mdt:' || (r ->> 'id');
    WHEN 'mandate_reservations' THEN
      mref := r ->> 'mandate_id'; ord := r ->> 'order_id';
      chain := CASE WHEN ord IS NULL THEN 'mdt:' || mref ELSE 'ord:' || ord END;
    WHEN 'api_keys' THEN
      chain := 'key:' || (r ->> 'id');
      buy := coalesce(r ->> 'agent_buyer_id', CASE WHEN r ->> 'owner_kind' = 'buyer' THEN r ->> 'owner_id' END);
    ELSE NULL;
  END CASE;
  IF chain IS NULL THEN
    chain := CASE
      WHEN tbl IN ('publishers', 'offers', 'publisher_applicant_decisions', 'payee_decisions', 'publisher_paypal_links') AND pub IS NOT NULL THEN 'pub:' || pub
      WHEN ord IS NOT NULL THEN 'ord:' || ord
      ELSE 'plat' END;
  END IF;
  RETURN jsonb_build_object('chain_key', chain, 'order_id', ord, 'unit_id', uni, 'mandate_ref', mref,
                            'publisher_id', pub, 'buyer_id', buy);
END;
$fn$;

-- The capture trigger, attached the same way 0023 attaches it.
CREATE TRIGGER trace_capture_publisher_paypal_links AFTER INSERT OR UPDATE ON publisher_paypal_links
  FOR EACH ROW EXECUTE FUNCTION trace_capture();

-- Rows that exist now land in the journal as system/backfill publisher_paypal_links.imported events. A second call
-- adds nothing.
SELECT trace_backfill();
