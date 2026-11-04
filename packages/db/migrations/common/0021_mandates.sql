-- SBX migration 0021: agent spending caps ("mandates"), their reservations, agent purchase claims and the
-- agent_buy_enabled switch (API-B, G1). Owned by SBX lane API-B. Forward-only: there is no down step.
-- The number is the next free one on main at merge time.
-- HARD PREREQUISITE: Supabase row level security for the three new tables (and grants that keep browser
-- roles off them) must exist before any Supabase use; until then they are reachable only by the server's
-- own connection (Supabase is unused, D-049). System only: no buyer, publisher or browser role reads them.
--
-- mandates: one cap a buyer gives to one of their own agent keys. Money (max_total_minor), a number of
-- purchases (max_count), or both; at least one. One currency, never converted. An optional per-purchase
-- maximum. spent_minor and used_count count held AND committed reservations, so a reserve is one
-- conditional UPDATE and the CHECKs below are a second guard if code ever bypasses it. exhausted_at stamps
-- the one mandate.exhausted event. revoked_at ends a mandate for good; an agent key has at most one open
-- (not revoked) mandate.
CREATE TABLE mandates (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  agent_key_id ums_id NOT NULL REFERENCES api_keys (id),
  currency ums_currency NOT NULL,
  max_total_minor integer,
  max_count integer,
  max_per_purchase_minor integer,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  spent_minor integer NOT NULL,
  used_count integer NOT NULL,
  exhausted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (max_total_minor IS NOT NULL OR max_count IS NOT NULL),
  CHECK (max_total_minor IS NULL OR max_total_minor > 0),
  CHECK (max_count IS NULL OR max_count > 0),
  CHECK (max_per_purchase_minor IS NULL OR max_per_purchase_minor > 0),
  CHECK (spent_minor >= 0 AND used_count >= 0),
  CHECK (max_total_minor IS NULL OR spent_minor <= max_total_minor),
  CHECK (max_count IS NULL OR used_count <= max_count)
);
CREATE UNIQUE INDEX mandates_one_open_per_key ON mandates (agent_key_id) WHERE revoked_at IS NULL;
CREATE INDEX mandates_buyer_idx ON mandates (buyer_id, created_at);

-- mandate_reservations: one row per purchase the cap has been booked for. held (booked, order not settled),
-- committed (the order was paid; the spend stays), released (the order ended unpaid; the room is given back).
CREATE TABLE mandate_reservations (
  id ums_id PRIMARY KEY,
  mandate_id ums_id NOT NULL REFERENCES mandates (id),
  order_id ums_id REFERENCES orders (id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  state text NOT NULL CHECK (state IN ('held', 'committed', 'released')),
  created_at timestamptz NOT NULL,
  settled_at timestamptz
);
CREATE INDEX mandate_reservations_mandate_idx ON mandate_reservations (mandate_id, state);
CREATE INDEX mandate_reservations_order_idx ON mandate_reservations (order_id);

-- agent_purchases: the claim an agent buy_unit call makes with its idempotency key, so a retry (even a
-- concurrent one) buys once. Keyed by the agent key and the key the agent sent. request_hash is the SHA-256
-- of the canonical arguments; the same key with other arguments is refused. result holds the stored answer.
CREATE TABLE agent_purchases (
  agent_key_id ums_id NOT NULL REFERENCES api_keys (id),
  idempotency_key text NOT NULL,
  request_hash ums_sha256 NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (agent_key_id, idempotency_key)
);

-- The seventh switch. Off at seed: nothing an agent does buys until an operator turns it on (MFA). The
-- name list is a CHECK, so the list is widened here and nowhere else; any other name stays refused.
ALTER TABLE safety_switches DROP CONSTRAINT safety_switches_name_check;
ALTER TABLE safety_switches ADD CONSTRAINT safety_switches_name_check CHECK (name IN (
  'paypal_outbound', 'checkout_enabled', 'refunds_enabled', 'unlock_enabled', 'ai_enabled', 'webhook_enabled',
  'agent_buy_enabled'
));
INSERT INTO safety_switches (name, "on", changed_by, changed_at, reason, created_at, updated_at) VALUES
  ('agent_buy_enabled', false, 'seed', '1970-01-01T00:00:00Z', 'seed: agent buying off until an operator turns it on', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
