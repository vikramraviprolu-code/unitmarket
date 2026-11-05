-- SBX migration 0025: alert state and history (INT-AL, AL.3).
-- An alert has no state column. Its state is the latest row of alert_events (none: open), so a change of
-- state is an append, the table is append-only, and who and when come from the journal of INT-TR0: the row
-- is a tracked table, so the capture trigger writes one trace_events row with the actor and the channel.
-- The note an operator may type with a resolve is never stored: only its sha256 (note_sha256), and the
-- reason code comes from a closed list. The ids of 0024 belong to SR0; this file does not depend on it.

CREATE TABLE alert_events (
  id ums_id PRIMARY KEY,
  alert_id ums_id NOT NULL REFERENCES alerts (id),
  kind text NOT NULL CHECK (kind IN ('acknowledged', 'resolved', 'auto_resolved', 'reopened')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('fixed_upstream', 'false_positive', 'duplicate', 'accepted_risk', 'other')),
  note_sha256 ums_sha256,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- seq orders events that carry the same time (two writes in one millisecond, or a frozen test clock).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (reason_code IS NULL OR kind = 'resolved'),
  CHECK (note_sha256 IS NULL OR kind = 'resolved')
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, seq);
CREATE TRIGGER alert_events_append_only BEFORE UPDATE OR DELETE ON alert_events
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER alert_events_no_truncate BEFORE TRUNCATE ON alert_events
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- The journal. alert_events joins the allow-list (the golden list in packages/contracts/src/trace.ts says the
-- same), its own seed function (below) refills its row after a reset, the subject lookup learns the
-- chain of an alert event (the chain of the order of its alert, or the platform chain when it has none), and
-- the capture trigger is attached.

-- 0023's trace_tracked_seed(), trace_tracked_reseed() and their trigger stay as they are. This lane owns its own
-- seed function and its own AFTER TRUNCATE trigger, so a reset that empties trace_tracked refills the row of
-- alert_events as well as every row of 0023, and a later lane that does the same under its own name cannot collide.
CREATE FUNCTION trace_tracked_seed_0025() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('alert_events', ARRAY['alert_id', 'kind', 'reason_code', 'note_sha256'], ARRAY[]::text[], ARRAY['id', 'alert_id', 'kind', 'reason_code', 'note_sha256', 'at', 'created_at', 'updated_at'], 'at', 'ord:alert_id')
  ;
$fn$;

CREATE FUNCTION trace_tracked_reseed_0025() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM trace_tracked_seed_0025();
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER trace_tracked_reseed_0025 AFTER TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION trace_tracked_reseed_0025();

SELECT trace_tracked_seed_0025();

CREATE OR REPLACE FUNCTION trace_subject(tbl text, r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  ord text; uni text; mref text; pub text; buy text; chain text; res jsonb;
BEGIN
  CASE tbl
    WHEN 'publishers' THEN pub := r ->> 'id';
    WHEN 'offers' THEN pub := r ->> 'publisher_id';
    WHEN 'publisher_applicant_decisions' THEN pub := r ->> 'publisher_id';
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
      WHEN tbl IN ('publishers', 'offers', 'publisher_applicant_decisions', 'payee_decisions') AND pub IS NOT NULL THEN 'pub:' || pub
      WHEN ord IS NOT NULL THEN 'ord:' || ord
      ELSE 'plat' END;
  END IF;
  RETURN jsonb_build_object('chain_key', chain, 'order_id', ord, 'unit_id', uni, 'mandate_ref', mref,
                            'publisher_id', pub, 'buyer_id', buy);
END;
$fn$;

CREATE TRIGGER trace_capture_alert_events AFTER INSERT OR UPDATE ON alert_events
  FOR EACH ROW EXECUTE FUNCTION trace_capture();
