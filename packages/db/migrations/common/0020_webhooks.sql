-- SBX migration 0020: webhook subscriptions, the fan-out marker and webhook deliveries (API-C, E1 and E2).
-- Owned by SBX lane API-C. Forward-only: there is no down step. Adds three tables and nothing else: no
-- change to any existing table, and none to the Supabase set (the policy for the new tables is a listed
-- follow-up, Supabase is unused, D-049). System only: the app reads and writes them with the server's own
-- connection; no buyer, publisher or browser role ever reads them directly.
--
-- webhook_subscriptions: one row per URL an owner subscribed. owner_kind and owner_id name who it belongs to
-- (buyer, publisher or operator, never system). event_types must be a non-empty subset of what that owner
-- kind may receive; this repeats the matrix of @umsbx/contracts (WEBHOOK_OWNER_EVENTS) so that no code path
-- can store a seller subscription to an order. url is https only, at most 2048 characters; the finer rules
-- (no IP literal, no localhost) are checked by the contract before a row is written. signing_secret is
-- 'whsec_' and 64 lowercase hex characters, drawn from the SecretSource; it is stored as it is because it
-- is needed to sign each delivery, and it is returned once at creation and never listed, logged or audited.
-- disabled_at is stamped in place; a disabled subscription keeps its rows and gets no new delivery.
-- HARD PREREQUISITE: Supabase row level security for webhook_subscriptions (and the grants that keep the
-- browser roles off it) must exist before any Supabase use; until then this table is reachable only by the
-- server's own connection, and signing_secret must never be exposed through a browser facing role.
-- No defaults: the writer states every value.
CREATE TABLE webhook_subscriptions (
  id ums_id PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('buyer', 'publisher', 'operator')),
  owner_id ums_id NOT NULL,
  url text NOT NULL CHECK (url ~* '^https://[^/?#[:space:]]' AND char_length(url) <= 2048),
  event_types text[] NOT NULL,
  signing_secret text NOT NULL CHECK (signing_secret ~ '^whsec_[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  disabled_at timestamptz,
  CHECK (
    cardinality(event_types) >= 1 AND (
      (owner_kind = 'buyer' AND event_types <@ ARRAY['order.paid', 'entitlement.granted', 'refund.completed', 'mandate.exhausted']::text[])
      OR (owner_kind = 'publisher' AND event_types <@ ARRAY['sale.recorded', 'refund.completed']::text[])
      OR (owner_kind = 'operator' AND event_types <@ ARRAY['settlement.completed']::text[])
    )
  )
);
CREATE INDEX webhook_subscriptions_owner_idx ON webhook_subscriptions (owner_kind, owner_id, created_at, id);

-- webhook_fanout: one row per outbox event the delivery pass has fanned out. event_outbox is append-only,
-- so "has this event been fanned out" cannot live on it; this marker does. An event with no matching
-- subscription is marked too, so it is not looked at again.
CREATE TABLE webhook_fanout (
  event_id ums_id PRIMARY KEY REFERENCES event_outbox (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- webhook_deliveries: one row per (event, subscription), so a replayed fan-out cannot add a second.
-- attempt counts sends started (the first send is attempt 1; a row not yet tried holds 0). status is
-- pending (not yet tried), failed (tried, will be tried again at next_at), delivered or dead (given up);
-- next_at is set exactly while a try is still to come. During a send, next_at holds the lease end. The
-- number of attempts is limited by the delivery pass, not here. last_error is a code from a closed list,
-- never the receiver's words, a URL or a secret.
CREATE TABLE webhook_deliveries (
  id ums_id PRIMARY KEY,
  event_id ums_id NOT NULL REFERENCES event_outbox (id),
  subscription_id ums_id NOT NULL REFERENCES webhook_subscriptions (id),
  attempt integer NOT NULL CHECK (attempt >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  next_at timestamptz,
  last_error text CHECK (last_error IN ('timeout', 'connection', 'http_4xx', 'http_5xx', 'sender_error', 'subscription_disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (event_id, subscription_id),
  CHECK ((status IN ('pending', 'failed')) = (next_at IS NOT NULL))
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_at, id) WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_subscription_idx ON webhook_deliveries (subscription_id, created_at, id);
