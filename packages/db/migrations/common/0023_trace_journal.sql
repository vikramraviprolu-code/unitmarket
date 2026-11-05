-- SBX migration 0023: the transaction journal (INT-TR0, trace spine).
-- Every insert or update of a money, delivery, agent-cap or control row writes one trace_events row in the same
-- transaction, by trigger, with the old and new value of each tracked column, the actor, the channel and a hash
-- that links it to the previous row of its chain. Which columns are copied is trace_tracked and nothing else;
-- the golden list in packages/contracts/src/trace.ts is checked against it (trace.golden.test.ts).
-- Rules: plain SQL, no extension, no DEFAULT and no now(): every time comes from the caller's clock, through
-- the ums.trace setting that withTraceDb sets. Runs unchanged on PGlite and stock Postgres 15+.
-- Notes (D-097): the free text of a row is never copied, only a sha256 of it; the digest of an append-only
-- row covers a frozen column list; verify runs in SQL (trace_verify) so no driver date parsing is involved.

-- ------------------------------------------------------------------------------------------------
-- Tables

CREATE TABLE trace_context (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web', 'api', 'mcp', 'job', 'webhook', 'cli', 'seed', 'backfill')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('buyer', 'publisher', 'operator', 'agent', 'api_client', 'system', 'paypal', 'unattributed')),
  actor_id text,
  on_behalf_of text,
  mandate_id text,
  mfa boolean NOT NULL,
  req_id text,
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{32}$'),
  ua_family text CHECK (ua_family IS NULL OR ua_family IN ('browser', 'curl', 'sdk', 'other')),
  api_key_id text,
  job text,
  tool text
);

-- ctx_id has no foreign key: pruning trace_context later never touches a chain.
CREATE TABLE trace_events (
  chain_key text NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  row_hash text NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('buyer', 'publisher', 'operator', 'agent', 'api_client', 'system', 'paypal', 'unattributed')),
  actor_id text,
  on_behalf_of text,
  mandate_id text,
  mfa boolean NOT NULL,
  ctx_id text,
  channel text CHECK (channel IS NULL OR channel IN ('web', 'api', 'mcp', 'job', 'webhook', 'cli', 'seed', 'backfill')),
  event_type text NOT NULL,
  source_table text NOT NULL,
  source_id text NOT NULL,
  order_id text,
  unit_id text,
  mandate_ref text,
  publisher_id text,
  buyer_id text,
  body jsonb NOT NULL,
  PRIMARY KEY (chain_key, seq)
);
CREATE INDEX trace_events_source_idx ON trace_events (source_table, source_id);
CREATE INDEX trace_events_ctx_idx ON trace_events (ctx_id);
CREATE INDEX trace_events_order_idx ON trace_events (order_id);

CREATE TABLE trace_heads (
  chain_key text PRIMARY KEY,
  seq bigint NOT NULL CHECK (seq >= 0),
  row_hash text NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE trace_seals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day date NOT NULL UNIQUE,
  at timestamptz NOT NULL,
  root_hash text NOT NULL CHECK (root_hash ~ '^[a-f0-9]{64}$'),
  prev_root_hash text NOT NULL CHECK (prev_root_hash ~ '^[a-f0-9]{64}$'),
  heads jsonb NOT NULL
);

CREATE TABLE trace_tracked (
  table_name text PRIMARY KEY,
  columns text[] NOT NULL,
  hashed_columns text[] NOT NULL,
  digest_columns text[] NOT NULL,
  time_column text NOT NULL,
  chain_expr text NOT NULL
);

-- UPDATE, DELETE and TRUNCATE raise, through the guards of migration 0001. A reset (ums.allow_reset) still
-- truncates them; trace_tracked is then filled again by the AFTER TRUNCATE trigger below.
CREATE TRIGGER trace_context_append_only BEFORE UPDATE OR DELETE ON trace_context
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER trace_context_no_truncate BEFORE TRUNCATE ON trace_context
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
CREATE TRIGGER trace_events_append_only BEFORE UPDATE OR DELETE ON trace_events
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER trace_events_no_truncate BEFORE TRUNCATE ON trace_events
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
CREATE TRIGGER trace_seals_append_only BEFORE UPDATE OR DELETE ON trace_seals
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER trace_seals_no_truncate BEFORE TRUNCATE ON trace_seals
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
CREATE TRIGGER trace_tracked_append_only BEFORE UPDATE OR DELETE ON trace_tracked
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER trace_tracked_no_truncate BEFORE TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- The allow-list. One row per tracked table: copied columns, hashed-only columns, the frozen digest column
-- list of the append-only tables, the time column and the chain.

CREATE FUNCTION trace_tracked_seed() RETURNS void LANGUAGE sql AS $fn$
  INSERT INTO trace_tracked (table_name, columns, hashed_columns, digest_columns, time_column, chain_expr) VALUES
    ('access_events', ARRAY['kind', 'at', 'source', 'seq'], ARRAY['evidence'], ARRAY['id', 'entitlement_id', 'link_id', 'kind', 'at', 'source', 'evidence', 'environment', 'created_at', 'updated_at', 'seq'], 'at', 'ord:entitlement_id'),
    ('access_windows', ARRAY['state', 'started_at', 'ends_at', 'paused_at', 'credit_ms'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'ord:entitlement_id'),
    ('alerts', ARRAY['kind', 'order_id', 'unit_id'], ARRAY['detail'], ARRAY[]::text[], 'created_at', 'ord:order_id'),
    ('api_keys', ARRAY['key_kind', 'scopes', 'revoked_at'], ARRAY[]::text[], ARRAY[]::text[], 'created_at', 'key:id'),
    ('approvals', ARRAY['content_hash', 'used_at', 'expires_at', 'environment'], ARRAY['snapshot'], ARRAY[]::text[], 'updated_at', 'buy:buyer_id'),
    ('audit_log', ARRAY['actor_kind', 'actor_id', 'action', 'target'], ARRAY['reason', 'detail'], ARRAY['id', 'actor_kind', 'actor_id', 'action', 'target', 'reason', 'detail', 'created_at', 'updated_at'], 'created_at', 'plat'),
    ('entitlements', ARRAY['money_state', 'access_state', 'licence_state', 'article_id', 'unit_id'], ARRAY['option', 'policy'], ARRAY[]::text[], 'updated_at', 'ord:unit_id'),
    ('ledger_entries', ARRAY['kind', 'amount_minor', 'currency', 'capture_id', 'refund_id', 'ref_entry_id'], ARRAY[]::text[], ARRAY['id', 'unit_id', 'capture_id', 'kind', 'amount_minor', 'currency', 'refund_id', 'ref_entry_id', 'environment', 'created_at', 'updated_at'], 'created_at', 'ord:unit_id'),
    ('links', ARRAY['expires_at', 'uses'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'ord:entitlement_id'),
    ('mandate_reservations', ARRAY['amount_minor', 'state', 'order_id', 'settled_at'], ARRAY[]::text[], ARRAY[]::text[], 'settled_at', 'mdt:mandate_id'),
    ('mandates', ARRAY['max_total_minor', 'max_count', 'max_per_purchase_minor', 'expires_at', 'revoked_at', 'spent_minor', 'used_count', 'exhausted_at'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'mdt:id'),
    ('offers', ARRAY['status'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'pub:publisher_id'),
    ('operations', ARRAY['kind', 'state', 'attempt', 'failure_reason'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'ord:order_id'),
    ('order_units', ARRAY['status', 'amount_minor', 'platform_fee_minor', 'paypal_fee_minor', 'refunded_minor', 'capture_id', 'captured_verified_at', 'status_reason', 'mismatch_reason'], ARRAY['payee_merchant_id'], ARRAY[]::text[], 'updated_at', 'ord:order_id'),
    ('orders', ARRAY['status', 'total_minor', 'currency', 'corridor_id', 'order_ref', 'environment'], ARRAY['expected'], ARRAY[]::text[], 'updated_at', 'ord:id'),
    ('outbound_approvals', ARRAY['scope', 'operations', 'max_amount_minor', 'max_calls_per_day', 'valid_until'], ARRAY['approved_by'], ARRAY[]::text[], 'updated_at', 'plat'),
    ('payee_decisions', ARRAY['decision', 'operator_id'], ARRAY['reason'], ARRAY['id', 'request_id', 'decision', 'operator_id', 'reason', 'created_at', 'updated_at'], 'created_at', 'pub:request_id'),
    ('provider_calls', ARRAY['operation', 'method', 'http_status', 'outcome', 'debug_id', 'transport_kind'], ARRAY['request_redacted', 'response_redacted'], ARRAY['id', 'operation_id', 'operation', 'method', 'path_template', 'http_status', 'outcome', 'debug_id', 'duration_ms', 'transport_kind', 'request_redacted', 'response_redacted', 'environment', 'created_at', 'updated_at'], 'created_at', 'ord:operation_id'),
    ('provider_orders', ARRAY['status', 'state', 'provider_order_id', 'publisher_id', 'position', 'first_approved_at'], ARRAY[]::text[], ARRAY[]::text[], 'updated_at', 'ord:order_id'),
    ('publisher_applicant_decisions', ARRAY['decision', 'operator_id'], ARRAY['reason'], ARRAY['id', 'publisher_id', 'decision', 'operator_id', 'reason', 'created_at', 'updated_at'], 'created_at', 'pub:publisher_id'),
    ('publishers', ARRAY['status', 'payee_verified_at', 'payee_shared'], ARRAY['paypal_merchant_id'], ARRAY[]::text[], 'updated_at', 'pub:id'),
    ('receipts', ARRAY['version', 'sha256'], ARRAY['body'], ARRAY['id', 'order_id', 'version', 'body', 'sha256', 'environment', 'created_at', 'updated_at'], 'created_at', 'ord:order_id'),
    ('recovery_actions', ARRAY['action', 'actor'], ARRAY['detail'], ARRAY['id', 'case_id', 'action', 'actor', 'detail', 'at', 'created_at', 'updated_at'], 'at', 'ord:case_id'),
    ('recovery_cases', ARRAY['kind', 'state', 'order_id', 'sla_due_at', 'credit_ms', 'opened_by'], ARRAY['buyer_message'], ARRAY[]::text[], 'updated_at', 'ord:order_id'),
    ('refund_requests', ARRAY['amount_minor', 'currency', 'state', 'refund_id', 'capture_id', 'requested_by'], ARRAY['reason'], ARRAY[]::text[], 'updated_at', 'ord:unit_id'),
    ('safety_switches', ARRAY['on', 'changed_at'], ARRAY['reason', 'changed_by'], ARRAY[]::text[], 'changed_at', 'plat'),
    ('webhook_events', ARRAY['event_id', 'type', 'verified', 'outcome', 'applied_at'], ARRAY['resource'], ARRAY[]::text[], 'received_at', 'ord:resource')
  ;
$fn$;

CREATE FUNCTION trace_tracked_reseed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM trace_tracked_seed();
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER trace_tracked_reseed AFTER TRUNCATE ON trace_tracked
  FOR EACH STATEMENT EXECUTE FUNCTION trace_tracked_reseed();

SELECT trace_tracked_seed();

-- ------------------------------------------------------------------------------------------------
-- Canonical text and hashes. Every function that renders a value pins the time zone and date style, so the
-- same row gives the same text in any session.

-- The jsonb of every column except row_hash. occurred_at is rendered in UTC with microseconds.
CREATE FUNCTION trace_canon(e trace_events) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_build_object(
    'chain_key', e.chain_key, 'seq', e.seq, 'prev_hash', e.prev_hash,
    'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_kind', e.actor_kind, 'actor_id', e.actor_id, 'on_behalf_of', e.on_behalf_of,
    'mandate_id', e.mandate_id, 'mfa', e.mfa, 'ctx_id', e.ctx_id, 'channel', e.channel,
    'event_type', e.event_type, 'source_table', e.source_table, 'source_id', e.source_id,
    'order_id', e.order_id, 'unit_id', e.unit_id, 'mandate_ref', e.mandate_ref,
    'publisher_id', e.publisher_id, 'buyer_id', e.buyer_id, 'body', e.body
  )::text
$fn$;

CREATE FUNCTION trace_sha(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex')
$fn$;

-- sha256 hex of the text of one column of a row (as jsonb); null stays null.
CREATE FUNCTION trace_hash_of(r jsonb, col text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN r -> col IS NULL OR r -> col = 'null'::jsonb THEN NULL
    WHEN jsonb_typeof(r -> col) = 'string' THEN trace_sha(r ->> col)
    ELSE trace_sha((r -> col)::text)
  END
$fn$;

-- The primary key of a tracked row, as one text.
CREATE FUNCTION trace_source_id(tbl text, r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE tbl
    WHEN 'offers' THEN (r ->> 'id') || ':' || (r ->> 'version')
    WHEN 'access_windows' THEN r ->> 'entitlement_id'
    WHEN 'safety_switches' THEN r ->> 'name'
    ELSE r ->> 'id'
  END
$fn$;

-- sha256 over the frozen digest columns of an append-only row (not row_to_json: a column added later does not
-- change it). Times are rendered by to_jsonb under the caller's pinned time zone.
CREATE FUNCTION trace_digest(tbl text, r jsonb) RETURNS text LANGUAGE sql AS $fn$
  SELECT trace_sha(coalesce(jsonb_object_agg(c, r -> c), '{}'::jsonb)::text)
    FROM trace_tracked t, unnest(t.digest_columns) AS c
   WHERE t.table_name = tbl
$fn$;

-- ------------------------------------------------------------------------------------------------
-- Subjects: the chain and the subject keys of a row.

CREATE FUNCTION trace_order_of_unit(u text) RETURNS text LANGUAGE sql AS $fn$
  SELECT order_id FROM order_units WHERE id = u
$fn$;
CREATE FUNCTION trace_order_of_entitlement(e text) RETURNS text LANGUAGE sql AS $fn$
  SELECT u.order_id FROM entitlements x JOIN order_units u ON u.id = x.unit_id WHERE x.id = e
$fn$;

CREATE FUNCTION trace_subject(tbl text, r jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
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

-- ------------------------------------------------------------------------------------------------
-- The event body: old and new value of each copied column, sha256 of each hashed column, the source digest.
-- Returns null when an update changes nothing in the allow-list.

CREATE FUNCTION trace_body(tbl text, op text, o jsonb, nw jsonb, n integer) RETURNS jsonb
  LANGUAGE plpgsql SET timezone = 'UTC' SET datestyle = 'ISO, MDY' AS $fn$
DECLARE
  cfg trace_tracked%ROWTYPE;
  col text; cols jsonb := '{}'::jsonb; hashed jsonb := '{}'::jsonb;
  ov jsonb; nv jsonb; oh text; nh text; body jsonb;
BEGIN
  SELECT * INTO cfg FROM trace_tracked WHERE table_name = tbl;
  FOREACH col IN ARRAY cfg.columns LOOP
    nv := coalesce(nw -> col, 'null'::jsonb);
    ov := CASE WHEN o IS NULL THEN 'null'::jsonb ELSE coalesce(o -> col, 'null'::jsonb) END;
    IF op <> 'update' OR ov IS DISTINCT FROM nv THEN
      cols := cols || jsonb_build_object(col, jsonb_build_array(ov, nv));
    END IF;
  END LOOP;
  FOREACH col IN ARRAY cfg.hashed_columns LOOP
    nh := trace_hash_of(nw, col);
    oh := CASE WHEN o IS NULL THEN NULL ELSE trace_hash_of(o, col) END;
    IF op <> 'update' OR oh IS DISTINCT FROM nh THEN
      hashed := hashed || jsonb_build_object(col, jsonb_build_array(to_jsonb(oh), to_jsonb(nh)));
    END IF;
  END LOOP;
  IF op = 'update' AND cols = '{}'::jsonb AND hashed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  body := jsonb_build_object('op', op, 'n', n, 'cols', cols, 'hashed', hashed);
  IF op <> 'update' AND cardinality(cfg.digest_columns) > 0 THEN
    body := body || jsonb_build_object('source_digest', trace_digest(tbl, nw));
  END IF;
  RETURN body;
END;
$fn$;

-- ------------------------------------------------------------------------------------------------
-- Appending to a chain. The head row of the chain is locked first, so two writers on one chain take their
-- seqs one after the other and no seq is used twice.

CREATE FUNCTION trace_append(p_table text, p_source_id text, p_event_type text, p_at timestamptz,
                             p_ctx jsonb, p_body jsonb, p_subject jsonb) RETURNS void
  LANGUAGE plpgsql AS $fn$
DECLARE
  k text := p_subject ->> 'chain_key';
  h trace_heads%ROWTYPE;
  e trace_events%ROWTYPE;
BEGIN
  SELECT * INTO h FROM trace_heads WHERE chain_key = k FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO trace_heads (chain_key, seq, row_hash) VALUES (k, 0, repeat('0', 64))
      ON CONFLICT (chain_key) DO NOTHING;
    SELECT * INTO h FROM trace_heads WHERE chain_key = k FOR UPDATE;
  END IF;
  e.chain_key := k;
  e.seq := h.seq + 1;
  e.prev_hash := h.row_hash;
  e.row_hash := repeat('0', 64);
  e.occurred_at := p_at;
  e.actor_kind := coalesce(p_ctx ->> 'actor_kind', 'unattributed');
  e.actor_id := p_ctx ->> 'actor_id';
  e.on_behalf_of := p_ctx ->> 'on_behalf_of';
  e.mandate_id := p_ctx ->> 'mandate_id';
  e.mfa := coalesce((p_ctx ->> 'mfa')::boolean, false);
  e.ctx_id := p_ctx ->> 'ctx_id';
  e.channel := p_ctx ->> 'channel';
  e.event_type := p_event_type;
  e.source_table := p_table;
  e.source_id := p_source_id;
  e.order_id := p_subject ->> 'order_id';
  e.unit_id := p_subject ->> 'unit_id';
  e.mandate_ref := p_subject ->> 'mandate_ref';
  e.publisher_id := p_subject ->> 'publisher_id';
  e.buyer_id := p_subject ->> 'buyer_id';
  e.body := p_body;
  e.row_hash := trace_sha(trace_canon(e));
  INSERT INTO trace_events VALUES (e.*);
  UPDATE trace_heads SET seq = e.seq, row_hash = e.row_hash WHERE chain_key = k;
END;
$fn$;

-- ------------------------------------------------------------------------------------------------
-- The capture trigger.

CREATE FUNCTION trace_capture() RETURNS trigger
  LANGUAGE plpgsql SET timezone = 'UTC' SET datestyle = 'ISO, MDY' AS $fn$
DECLARE
  cfg trace_tracked%ROWTYPE;
  ctx jsonb; nw jsonb := to_jsonb(NEW); od jsonb; sid text; n integer; body jsonb;
  tn timestamptz; at_ timestamptz; changed boolean;
BEGIN
  ctx := nullif(current_setting('ums.trace', true), '')::jsonb;
  -- A restore loads rows that already carry their events: nothing is journaled twice.
  IF ctx ->> 'mode' = 'restore' THEN RETURN NULL; END IF;
  SELECT * INTO cfg FROM trace_tracked WHERE table_name = TG_TABLE_NAME;
  sid := trace_source_id(TG_TABLE_NAME, nw);
  IF TG_OP = 'UPDATE' THEN od := to_jsonb(OLD); END IF;
  SELECT count(*) + 1 INTO n FROM trace_events WHERE source_table = TG_TABLE_NAME AND source_id = sid;
  body := trace_body(TG_TABLE_NAME, CASE TG_OP WHEN 'INSERT' THEN 'insert' ELSE 'update' END, od, nw, n);
  IF body IS NULL THEN RETURN NULL; END IF;
  tn := (nw ->> cfg.time_column)::timestamptz;
  changed := TG_OP = 'INSERT' OR (od ->> cfg.time_column) IS DISTINCT FROM (nw ->> cfg.time_column);
  IF ctx ->> 'ctx_id' IS NOT NULL THEN
    at_ := CASE WHEN changed AND tn IS NOT NULL THEN tn ELSE (ctx ->> 'at')::timestamptz END;
    INSERT INTO trace_context (id, at, channel, actor_kind, actor_id, on_behalf_of, mandate_id, mfa, req_id,
                               ip_hash, ua_family, api_key_id, job, tool)
    VALUES (ctx ->> 'ctx_id', (ctx ->> 'ctx_at')::timestamptz, ctx ->> 'channel', ctx ->> 'actor_kind',
            ctx ->> 'actor_id', ctx ->> 'on_behalf_of', ctx ->> 'mandate_id', (ctx ->> 'mfa')::boolean,
            ctx ->> 'req_id', ctx ->> 'ip_hash', ctx ->> 'ua_family', ctx ->> 'api_key_id', ctx ->> 'job',
            ctx ->> 'tool')
    ON CONFLICT (id) DO NOTHING;
  ELSE
    at_ := coalesce(tn, (nw ->> 'created_at')::timestamptz, 'epoch'::timestamptz);
  END IF;
  PERFORM trace_append(TG_TABLE_NAME, sid, TG_TABLE_NAME || CASE TG_OP WHEN 'INSERT' THEN '.created' ELSE '.updated' END,
                       at_, ctx, body, trace_subject(TG_TABLE_NAME, nw));
  RETURN NULL;
END;
$fn$;

DO $do$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM trace_tracked ORDER BY table_name LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trace_capture()',
                   'trace_capture_' || t, t);
  END LOOP;
END
$do$;

-- ------------------------------------------------------------------------------------------------
-- Backfill (TR0.6): one system/backfill "<table>.imported" event per tracked row that has none. A second call
-- adds nothing. It returns the number of events it wrote.

CREATE FUNCTION trace_backfill() RETURNS integer
  LANGUAGE plpgsql SET timezone = 'UTC' SET datestyle = 'ISO, MDY' AS $fn$
DECLARE
  cfg trace_tracked%ROWTYPE; r record; sid text; tn timestamptz; body jsonb; cnt integer := 0;
BEGIN
  FOR cfg IN SELECT * FROM trace_tracked ORDER BY table_name COLLATE "C" LOOP
    FOR r IN EXECUTE format('SELECT to_jsonb(x) AS j FROM %I x ORDER BY trace_source_id(%L, to_jsonb(x)) COLLATE "C"',
                            cfg.table_name, cfg.table_name) LOOP
      sid := trace_source_id(cfg.table_name, r.j);
      CONTINUE WHEN EXISTS (SELECT 1 FROM trace_events WHERE source_table = cfg.table_name AND source_id = sid);
      tn := coalesce((r.j ->> cfg.time_column)::timestamptz, (r.j ->> 'created_at')::timestamptz, 'epoch'::timestamptz);
      body := trace_body(cfg.table_name, 'imported', NULL, r.j, 1);
      PERFORM trace_append(cfg.table_name, sid, cfg.table_name || '.imported', tn,
                           jsonb_build_object('actor_kind', 'system', 'channel', 'backfill', 'mfa', false),
                           body, trace_subject(cfg.table_name, r.j));
      cnt := cnt + 1;
    END LOOP;
  END LOOP;
  RETURN cnt;
END;
$fn$;

-- ------------------------------------------------------------------------------------------------
-- Seals. At most one row per day; a second call for the same day returns the first. The heads are every
-- chain's last row at call time, ordered by chain_key. A late row falls into the next seal.

CREATE FUNCTION trace_seal(p_day date, p_at timestamptz) RETURNS trace_seals
  LANGUAGE plpgsql SET datestyle = 'ISO, MDY' AS $fn$
DECLARE
  s trace_seals%ROWTYPE; prev text; hs jsonb;
BEGIN
  SELECT * INTO s FROM trace_seals WHERE day = p_day;
  IF FOUND THEN RETURN s; END IF;
  SELECT root_hash INTO prev FROM trace_seals ORDER BY id DESC LIMIT 1;
  prev := coalesce(prev, repeat('0', 64));
  SELECT coalesce(jsonb_agg(jsonb_build_object('chain_key', chain_key, 'seq', seq, 'row_hash', row_hash)
                            ORDER BY chain_key COLLATE "C"), '[]'::jsonb)
    INTO hs FROM trace_heads WHERE seq > 0;
  INSERT INTO trace_seals (day, at, root_hash, prev_root_hash, heads)
  VALUES (p_day, p_at, trace_sha(prev || '|' || p_day::text || '|' || hs::text), prev, hs)
  ON CONFLICT (day) DO NOTHING;
  SELECT * INTO s FROM trace_seals WHERE day = p_day;
  RETURN s;
END;
$fn$;

-- ------------------------------------------------------------------------------------------------
-- Verify. Read only. One row per broken thing, naming the chain and the row where there is one.

CREATE FUNCTION trace_verify() RETURNS TABLE (kind text, chain_key text, seq bigint, detail text)
  LANGUAGE plpgsql STABLE SET timezone = 'UTC' SET datestyle = 'ISO, MDY' AS $fn$
DECLARE
  s trace_seals%ROWTYPE; prev text := repeat('0', 64); hd jsonb;
  cfg trace_tracked%ROWTYPE; r record; sid text; ev record; state jsonb; hstate jsonb; col text; cur jsonb;
  dg text; fst record;
BEGIN
  -- chain: seq runs 1, 2, 3 without a gap, prev_hash links to the previous row, row_hash recomputes.
  RETURN QUERY
  SELECT 'chain'::text, z.chain_key, z.seq, z.problem FROM (
    SELECT y.chain_key, y.seq, CASE
      WHEN y.p_seq IS NULL AND y.seq <> 1 THEN 'chain does not start at seq 1'
      WHEN y.p_seq IS NOT NULL AND y.seq <> y.p_seq + 1 THEN 'seq jumps from ' || y.p_seq || ' to ' || y.seq
      WHEN y.prev_hash <> coalesce(y.p_hash, repeat('0', 64)) THEN 'prev_hash does not match the previous row'
      WHEN y.row_hash <> y.calc THEN 'row_hash does not match the row'
    END AS problem
    FROM (
      SELECT e.chain_key, e.seq, e.prev_hash, e.row_hash,
             lag(e.row_hash) OVER w AS p_hash, lag(e.seq) OVER w AS p_seq,
             trace_sha(trace_canon(e)) AS calc
        FROM trace_events e WINDOW w AS (PARTITION BY e.chain_key ORDER BY e.seq)
    ) y
  ) z WHERE z.problem IS NOT NULL ORDER BY z.chain_key COLLATE "C", z.seq;

  -- head: each trace_heads row is the last row of its chain, and every chain has one.
  RETURN QUERY
  SELECT 'head'::text, coalesce(h.chain_key, l.chain_key), coalesce(h.seq, l.seq),
         CASE WHEN h.chain_key IS NULL THEN 'chain has rows but no head'
              WHEN l.chain_key IS NULL THEN 'head names a chain with no rows'
              WHEN h.seq <> l.seq THEN 'head is at seq ' || h.seq || ' but the last row of the chain is seq ' || l.seq
              ELSE 'head row_hash is not the row_hash of the last row' END
    FROM trace_heads h
    FULL JOIN (SELECT DISTINCT ON (e.chain_key) e.chain_key, e.seq, e.row_hash FROM trace_events e
                ORDER BY e.chain_key, e.seq DESC) l ON l.chain_key = h.chain_key
   WHERE (h.chain_key IS NULL OR l.chain_key IS NULL OR h.seq <> l.seq OR h.row_hash <> l.row_hash)
     AND NOT (h.chain_key IS NOT NULL AND h.seq = 0 AND l.chain_key IS NULL)
   ORDER BY 2;

  -- seal: each root recomputes from the previous root, and every sealed head still exists unchanged.
  FOR s IN SELECT * FROM trace_seals ORDER BY id LOOP
    IF s.prev_root_hash <> prev THEN
      kind := 'seal'; chain_key := NULL; seq := NULL;
      detail := 'seal ' || s.day::text || ': prev_root_hash is not the root_hash of the previous seal';
      RETURN NEXT;
    END IF;
    IF s.root_hash <> trace_sha(s.prev_root_hash || '|' || s.day::text || '|' || s.heads::text) THEN
      kind := 'seal'; chain_key := NULL; seq := NULL;
      detail := 'seal ' || s.day::text || ': root_hash does not recompute';
      RETURN NEXT;
    END IF;
    prev := s.root_hash;
    FOR hd IN SELECT value FROM jsonb_array_elements(s.heads) LOOP
      IF NOT EXISTS (SELECT 1 FROM trace_events e WHERE e.chain_key = hd ->> 'chain_key'
                        AND e.seq = (hd ->> 'seq')::bigint AND e.row_hash = hd ->> 'row_hash') THEN
        kind := 'seal'; chain_key := hd ->> 'chain_key'; seq := (hd ->> 'seq')::bigint;
        detail := 'sealed row of seal ' || s.day::text || ' is missing or changed';
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;

  -- digest and drift, table by table.
  FOR cfg IN SELECT * FROM trace_tracked ORDER BY table_name COLLATE "C" LOOP
    FOR r IN EXECUTE format('SELECT to_jsonb(x) AS j FROM %I x ORDER BY trace_source_id(%L, to_jsonb(x)) COLLATE "C"',
                            cfg.table_name, cfg.table_name) LOOP
      sid := trace_source_id(cfg.table_name, r.j);
      state := '{}'::jsonb; hstate := '{}'::jsonb; fst := NULL;
      FOR ev IN SELECT e.chain_key, e.seq, e.body FROM trace_events e
                 WHERE e.source_table = cfg.table_name AND e.source_id = sid
                 ORDER BY (e.body ->> 'n')::integer, e.chain_key, e.seq LOOP
        IF fst IS NULL THEN fst := ev; END IF;
        state := state || coalesce((SELECT jsonb_object_agg(k, v -> 1) FROM jsonb_each(ev.body -> 'cols') AS t(k, v)), '{}'::jsonb);
        hstate := hstate || coalesce((SELECT jsonb_object_agg(k, v -> 1) FROM jsonb_each(ev.body -> 'hashed') AS t(k, v)), '{}'::jsonb);
      END LOOP;
      IF fst IS NULL THEN
        kind := 'drift'; chain_key := NULL; seq := NULL;
        detail := 'drift ' || cfg.table_name || ' ' || sid || ': the row has no journal event';
        RETURN NEXT;
        CONTINUE;
      END IF;
      IF cardinality(cfg.digest_columns) > 0 THEN
        dg := trace_digest(cfg.table_name, r.j);
        IF fst.body ->> 'source_digest' IS DISTINCT FROM dg THEN
          kind := 'digest'; chain_key := fst.chain_key; seq := fst.seq;
          detail := 'digest ' || cfg.table_name || ' ' || sid || ' differs from the digest taken when it was written';
          RETURN NEXT;
        END IF;
      END IF;
      FOREACH col IN ARRAY cfg.columns LOOP
        IF coalesce(state -> col, 'null'::jsonb) IS DISTINCT FROM coalesce(r.j -> col, 'null'::jsonb) THEN
          kind := 'drift'; chain_key := NULL; seq := NULL;
          detail := 'drift ' || cfg.table_name || ' ' || sid || ' ' || col;
          RETURN NEXT;
        END IF;
      END LOOP;
      FOREACH col IN ARRAY cfg.hashed_columns LOOP
        IF coalesce(hstate -> col, 'null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(trace_hash_of(r.j, col)), 'null'::jsonb) THEN
          kind := 'drift'; chain_key := NULL; seq := NULL;
          detail := 'drift ' || cfg.table_name || ' ' || sid || ' ' || col;
          RETURN NEXT;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN;
END;
$fn$;

-- How many values verify compared: journal rows, heads, and every copied or hashed column of every tracked row.
CREATE FUNCTION trace_checked() RETURNS bigint LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  cfg trace_tracked%ROWTYPE; total bigint; n bigint;
BEGIN
  SELECT (SELECT count(*) FROM trace_events) + (SELECT count(*) FROM trace_heads) INTO total;
  FOR cfg IN SELECT * FROM trace_tracked LOOP
    EXECUTE format('SELECT count(*) FROM %I', cfg.table_name) INTO n;
    total := total + n * (cardinality(cfg.columns) + cardinality(cfg.hashed_columns) + 1);
  END LOOP;
  RETURN total;
END;
$fn$;

-- ------------------------------------------------------------------------------------------------
-- Rows that exist before this migration are journaled once, in the migration transaction, so no write of the
-- app can land before it.

SELECT trace_backfill();
