-- SBX migration 0004: approvals, orders, provider orders, units, operations, provider calls,
-- webhooks, refunds, ledger, receipts. Races and tampering fail here, in the database.
-- Adapted from AIC_Hackathon_UnitMarket packages/db/migrations/0001_init.sql, 0100_app_layer.sql,
-- 0102_truncate_guards.sql and 0103_ledger_commission_rest.sql at a36ddc03fd0b962000f686291c145b50ee337f90.
-- Owned by SBX lane 12. `environment` is 'dryrun' or 'sandbox' only; 'live' cannot be stored (P15, P16).

CREATE TABLE approvals (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  snapshot jsonb NOT NULL,
  content_hash ums_sha256 NOT NULL,
  nonce text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- APPROVAL_TTL_MS in the contract is 15 minutes; a use cannot come after the expiry.
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK (used_at IS NULL OR used_at <= expires_at)
);

-- An approval is frozen: the only allowed UPDATE sets used_at once, from NULL to a value, and
-- changes nothing else (updated_at excepted). DELETE and TRUNCATE are refused.
CREATE FUNCTION ums_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'approval % is already used and cannot change', OLD.id;
  END IF;
  IF NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'approval % can only be updated to set used_at', OLD.id;
  END IF;
  IF (NEW.id, NEW.buyer_id, NEW.snapshot, NEW.content_hash, NEW.nonce, NEW.created_at, NEW.expires_at, NEW.environment)
     IS DISTINCT FROM
     (OLD.id, OLD.buyer_id, OLD.snapshot, OLD.content_hash, OLD.nonce, OLD.created_at, OLD.expires_at, OLD.environment) THEN
    RAISE EXCEPTION 'approval % is immutable except used_at', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approvals_guard BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ums_approval_guard();
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER approvals_no_truncate BEFORE TRUNCATE ON approvals
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

CREATE TABLE orders (
  id ums_id PRIMARY KEY,
  approval_id ums_id NOT NULL UNIQUE REFERENCES approvals (id),
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  content_hash ums_sha256 NOT NULL,
  order_ref ums_id NOT NULL UNIQUE,
  expected jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'created', 'awaiting_buyer', 'capture_requested', 'capture_claimed', 'unresolved',
    'paid', 'paid_partial', 'failed', 'abandoned', 'frozen'
  )),
  mismatch boolean NOT NULL,
  corridor_id ums_id NOT NULL REFERENCES corridors (id),
  currency ums_currency NOT NULL,
  total_minor ums_minor NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- One open order per buyer and content hash; the database decides the race.
CREATE UNIQUE INDEX orders_one_open_per_buyer_hash ON orders (buyer_id, content_hash)
  WHERE status NOT IN ('paid', 'paid_partial', 'failed', 'abandoned');

-- The order currency is the corridor's currency (replaces a literal CHECK (currency = 'USD')).
CREATE FUNCTION ums_order_currency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  corridor_currency text;
BEGIN
  SELECT currency INTO corridor_currency FROM corridors WHERE id = NEW.corridor_id;
  IF corridor_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'order currency % does not match corridor % currency %', NEW.currency, NEW.corridor_id, corridor_currency;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_currency_guard BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION ums_order_currency_guard();

-- An order carries the buyer and the environment of the approval it consumes.
CREATE FUNCTION ums_order_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approval_buyer text;
  approval_env text;
BEGIN
  SELECT buyer_id, environment INTO approval_buyer, approval_env FROM approvals WHERE id = NEW.approval_id;
  IF approval_buyer IS DISTINCT FROM NEW.buyer_id THEN
    RAISE EXCEPTION 'order buyer % does not match approval % buyer %', NEW.buyer_id, NEW.approval_id, approval_buyer;
  END IF;
  IF approval_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION 'order environment % does not match approval % environment %', NEW.environment, NEW.approval_id, approval_env;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_approval_guard BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION ums_order_approval_guard();

-- One internal order maps to 1..N PayPal orders (composite route).
CREATE TABLE provider_orders (
  id ums_id PRIMARY KEY,
  order_id ums_id NOT NULL REFERENCES orders (id),
  provider_order_id text UNIQUE CHECK (provider_order_id ~ '^[A-Z0-9]{1,36}$'),
  route text NOT NULL CHECK (route IN ('single', 'per_publisher')),
  -- Only the sandbox approval host is ever stored (P15); the contract checks the same prefix.
  approve_url text CHECK (approve_url IS NULL OR approve_url ~ '^https://www\.sandbox\.paypal\.com/[^[:space:][:cntrl:]]*$'),
  status text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE order_units (
  id ums_id PRIMARY KEY,
  order_id ums_id NOT NULL REFERENCES orders (id),
  provider_order_ref ums_id REFERENCES provider_orders (id),
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  reference_id ums_id NOT NULL,
  payee_merchant_id ums_id NOT NULL,
  amount_minor ums_minor NOT NULL,
  platform_fee_minor ums_minor NOT NULL CHECK (platform_fee_minor = 0),
  capture_id text UNIQUE,
  status text NOT NULL CHECK (status IN (
    'expected', 'captured_verified', 'pending', 'declined', 'mismatch',
    'partially_refunded', 'refunded', 'reversal_suspected', 'reversed'
  )),
  status_reason text,
  paypal_fee_minor ums_minor,
  refunded_minor ums_minor NOT NULL,
  captured_verified_at timestamptz,
  mismatch_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (order_id, reference_id),
  -- Target of the ledger's composite foreign key: a ledger row's capture belongs to its unit.
  UNIQUE (id, capture_id),
  CHECK (refunded_minor <= amount_minor),
  -- A captured state always has the capture id and the time it was verified.
  CHECK (
    status NOT IN ('captured_verified', 'partially_refunded', 'refunded', 'reversal_suspected', 'reversed')
    OR (capture_id IS NOT NULL AND captured_verified_at IS NOT NULL)
  )
);

CREATE TABLE operations (
  id ums_id PRIMARY KEY,
  order_id ums_id NOT NULL REFERENCES orders (id),
  unit_id ums_id REFERENCES order_units (id),
  kind text NOT NULL CHECK (kind IN ('create', 'capture', 'readback', 'refund', 'refund_readback')),
  state text NOT NULL CHECK (state IN ('prepared', 'sent', 'unknown', 'confirmed', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 0),
  request_id ums_id NOT NULL UNIQUE,
  first_sent_at timestamptz,
  idem_safe_until timestamptz,
  lease_until timestamptz,
  next_retry_at timestamptz,
  reconcile_until timestamptz,
  failure_reason text CHECK (failure_reason IN (
    'declined', 'mismatch', 'unparseable', 'window_expired', 'invalid_request', 'rejected'
  )),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state NOT IN ('prepared', 'sent') OR lease_until IS NOT NULL),
  CHECK (state <> 'unknown' OR reconcile_until IS NOT NULL),
  CHECK ((state = 'failed') = (failure_reason IS NOT NULL))
);

-- Redacted audit of every outbound call. Append-only.
CREATE TABLE provider_calls (
  id ums_id PRIMARY KEY,
  operation_id ums_id REFERENCES operations (id),
  operation text NOT NULL,
  method text NOT NULL,
  path_template text NOT NULL,
  http_status integer,
  outcome text NOT NULL,
  debug_id text,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  transport_kind text NOT NULL CHECK (transport_kind IN ('dryrun', 'sandbox')),
  request_redacted jsonb NOT NULL,
  response_redacted jsonb NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER provider_calls_append_only BEFORE UPDATE OR DELETE ON provider_calls
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER provider_calls_no_truncate BEFORE TRUNCATE ON provider_calls
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

CREATE TABLE webhook_events (
  id ums_id PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  transmission_id text NOT NULL UNIQUE,
  type text NOT NULL,
  verified boolean NOT NULL,
  outcome text,
  resource jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  applied_at timestamptz,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE refund_requests (
  id ums_id PRIMARY KEY,
  unit_id ums_id NOT NULL REFERENCES order_units (id),
  capture_id text NOT NULL,
  amount_minor ums_minor,
  currency ums_currency NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL,
  state text NOT NULL,
  refund_id text UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Append-only money ledger. refund and commission_reversal rows carry a refund_id and no other
-- kind does, so the NULLS NOT DISTINCT unique key allows one row per refund id and exactly one row
-- of every other kind per capture; a partial unique index states the one-sale rule on its own. The
-- composite foreign key ties the capture id to the unit that owns it. The guard trigger checks the
-- currency against the order and keeps refunds within the sale.
CREATE TABLE ledger_entries (
  id ums_id PRIMARY KEY,
  unit_id ums_id NOT NULL,
  capture_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'sale', 'paypal_fee', 'platform_fee', 'refund', 'reversal', 'commission_reversal'
  )),
  amount_minor ums_minor NOT NULL,
  currency ums_currency NOT NULL,
  refund_id text,
  ref_entry_id ums_id REFERENCES ledger_entries (id),
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (capture_id, kind, refund_id),
  FOREIGN KEY (unit_id, capture_id) REFERENCES order_units (id, capture_id),
  CHECK ((kind IN ('refund', 'commission_reversal')) = (refund_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_entries_one_sale_per_capture ON ledger_entries (capture_id) WHERE kind = 'sale';

CREATE FUNCTION ums_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_currency text;
  sale_total numeric;
  refunded_total numeric;
BEGIN
  -- Lock the unit row so two concurrent refunds on one capture are checked one after the other.
  SELECT o.currency INTO order_currency
    FROM order_units u JOIN orders o ON o.id = u.order_id
    WHERE u.id = NEW.unit_id FOR UPDATE OF u;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the missing unit
  END IF;
  IF order_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'ledger currency % does not match order currency %', NEW.currency, order_currency;
  END IF;
  IF NEW.kind = 'refund' THEN
    SELECT coalesce(sum(amount_minor), 0) INTO sale_total
      FROM ledger_entries WHERE capture_id = NEW.capture_id AND kind = 'sale';
    SELECT coalesce(sum(amount_minor), 0) INTO refunded_total
      FROM ledger_entries WHERE capture_id = NEW.capture_id AND kind = 'refund';
    IF refunded_total + NEW.amount_minor > sale_total THEN
      RAISE EXCEPTION 'refunds % would exceed the sale % for capture %', refunded_total + NEW.amount_minor, sale_total, NEW.capture_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_guard BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ums_ledger_guard();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- Versioned, immutable receipts.
CREATE TABLE receipts (
  id ums_id PRIMARY KEY,
  order_id ums_id NOT NULL REFERENCES orders (id),
  version integer NOT NULL CHECK (version >= 1),
  body jsonb NOT NULL,
  sha256 ums_sha256 NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (order_id, version)
);
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
