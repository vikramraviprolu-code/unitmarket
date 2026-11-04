-- SBX migration 0019: API keys and the event outbox (API-W0, F1 and F3). Owned by SBX lane API-W0.
-- Forward-only: there is no down step. Adds two tables and nothing else: no change to buyers, publishers,
-- sessions or any other table, and none to the Supabase set (the policy for the new tables is a listed
-- follow-up, Supabase is unused, D-049). System only: the app reads and writes them with the server's own
-- connection; no buyer, publisher or browser role ever reads them directly.
--
-- api_keys: one row per issued key for the /api/v1 surface. The secret is never stored: secret_hash is the
-- SHA-256 hex of the secret part only. owner_kind and owner_id name who the key acts for (buyer, publisher
-- or operator, never system). key_kind is api_client (acts as its owner, within its scopes) or agent (acts
-- as one buyer, within the agent scopes). An agent key names its buyer in agent_buyer_id, which must be its
-- owner and must exist; no other key names one. scopes holds one or more scope names; the owner scope matrix
-- is enforced by the key service, not here, so a later scope needs no migration. revoked_at and last_used_at
-- are stamped in place.
-- HARD PREREQUISITE: Supabase row level security for api_keys and event_outbox (and the grants that keep the
-- browser roles off them) must exist before any Supabase use; until then these tables are reachable only by
-- the server's own connection, and secret_hash must never be exposed through a browser facing role.
-- No defaults: the writer states every value.
CREATE TABLE api_keys (
  id ums_id PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('buyer', 'publisher', 'operator')),
  owner_id ums_id NOT NULL,
  key_kind text NOT NULL CHECK (key_kind IN ('api_client', 'agent')),
  agent_buyer_id ums_id REFERENCES buyers (id),
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  secret_hash ums_sha256 NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK ((key_kind = 'agent') = (agent_buyer_id IS NOT NULL)),
  CHECK (key_kind <> 'agent' OR (owner_kind = 'buyer' AND agent_buyer_id = owner_id))
);
CREATE INDEX api_keys_owner_idx ON api_keys (owner_kind, owner_id);

-- event_outbox: the append-only list of domain events a later delivery job reads (API-W0, F1). Rows are
-- written in the same transaction as the change they describe, with the id, type, a validated JSON
-- payload of ids, amounts and times only (no personal data, no secret) and the time the event happened.
-- Order is occurred_at then id. UPDATE, DELETE and TRUNCATE are refused.
CREATE TABLE event_outbox (
  id ums_id PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX event_outbox_order_idx ON event_outbox (occurred_at, id);
CREATE TRIGGER event_outbox_append_only BEFORE UPDATE OR DELETE ON event_outbox
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER event_outbox_no_truncate BEFORE TRUNCATE ON event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
