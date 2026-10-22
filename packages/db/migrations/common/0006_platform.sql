-- SBX migration 0006: recovery, alerts, idempotency, rate limits, audit, safety switches,
-- outbound approvals. Owned by SBX lane 12.
-- Adapted from AIC_Hackathon_UnitMarket packages/db/migrations/0103_ledger_commission_rest.sql
-- (alerts unique) at a36ddc03fd0b962000f686291c145b50ee337f90.

CREATE TABLE recovery_cases (
  id ums_id PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'delivery_failed', 'payment_unresolved', 'frozen_order', 'partial_composite', 'refund_requested', 'reversal'
  )),
  state text NOT NULL CHECK (state IN (
    'open', 'diagnosing', 'restored', 'closed_not_charged', 'refund_pending', 'refunded', 'closed_no_fault', 'closed'
  )),
  order_id ums_id REFERENCES orders (id),
  entitlement_id ums_id REFERENCES entitlements (id),
  buyer_id ums_id REFERENCES buyers (id),
  opened_by text NOT NULL CHECK (opened_by IN ('system', 'buyer', 'operator')),
  sla_due_at timestamptz NOT NULL,
  credit_ms integer NOT NULL CHECK (credit_ms >= 0),
  buyer_message text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE recovery_actions (
  id ums_id PRIMARY KEY,
  case_id ums_id NOT NULL REFERENCES recovery_cases (id),
  action text NOT NULL,
  actor text NOT NULL,
  detail jsonb NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER recovery_actions_append_only BEFORE UPDATE OR DELETE ON recovery_actions
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER recovery_actions_no_truncate BEFORE TRUNCATE ON recovery_actions
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

CREATE TABLE alerts (
  id ums_id PRIMARY KEY,
  kind text NOT NULL,
  order_id ums_id REFERENCES orders (id),
  unit_id ums_id REFERENCES order_units (id),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- One alert of a kind per order, unit and reason; a repeated read raises nothing new.
CREATE UNIQUE INDEX alerts_one_per_kind ON alerts (kind, order_id, unit_id, (detail ->> 'reason')) NULLS NOT DISTINCT;

CREATE TABLE api_idempotency (
  id ums_id PRIMARY KEY,
  key text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  route text NOT NULL,
  request_sha256 ums_sha256 NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (actor_kind, actor_id, key)
);

CREATE TABLE rate_buckets (
  bucket_key text PRIMARY KEY,
  tokens integer NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id ums_id PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('buyer', 'publisher', 'operator', 'system')),
  actor_id text,
  action text NOT NULL,
  target text,
  reason text,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

CREATE TABLE safety_switches (
  name text PRIMARY KEY CHECK (name IN (
    'paypal_outbound', 'checkout_enabled', 'refunds_enabled', 'unlock_enabled', 'ai_enabled', 'webhook_enabled'
  )),
  "on" boolean NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE outbound_approvals (
  id ums_id PRIMARY KEY,
  approval_ref text NOT NULL UNIQUE,
  scope text NOT NULL,
  operations text[] NOT NULL,
  max_amount_minor ums_minor NOT NULL,
  max_calls_per_day integer NOT NULL CHECK (max_calls_per_day >= 0),
  valid_until timestamptz NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER outbound_approvals_append_only BEFORE UPDATE OR DELETE ON outbound_approvals
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER outbound_approvals_no_truncate BEFORE TRUNCATE ON outbound_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- Seed: paypal_outbound is off (fail-closed); the other five switches start on.
INSERT INTO safety_switches (name, "on", changed_by, changed_at, reason, created_at, updated_at) VALUES
  ('paypal_outbound', false, 'seed', '1970-01-01T00:00:00Z', 'seed: outbound off until the owner approves', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('checkout_enabled', true, 'seed', '1970-01-01T00:00:00Z', 'seed', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('refunds_enabled', true, 'seed', '1970-01-01T00:00:00Z', 'seed', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('unlock_enabled', true, 'seed', '1970-01-01T00:00:00Z', 'seed', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('ai_enabled', true, 'seed', '1970-01-01T00:00:00Z', 'seed', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('webhook_enabled', true, 'seed', '1970-01-01T00:00:00Z', 'seed', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
