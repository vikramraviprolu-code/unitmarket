-- SBX migration 0005: entitlements, access windows, links, access events. Owned by SBX lane 12.
-- Adapted from AIC_Hackathon_UnitMarket packages/db/migrations/0001_init.sql (entitlements CHECKs)
-- at a36ddc03fd0b962000f686291c145b50ee337f90.

CREATE TABLE entitlements (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  article_id ums_id NOT NULL REFERENCES articles (id),
  unit_id ums_id NOT NULL REFERENCES order_units (id),
  option text NOT NULL CHECK (option IN ('keep_retrieve', 'online_read')),
  policy jsonb NOT NULL,
  money_state text NOT NULL CHECK (money_state IN (
    'pending', 'captured', 'denied', 'refunded', 'reversed', 'unknown'
  )),
  access_state text NOT NULL CHECK (access_state IN ('locked', 'available', 'ended', 'revoked')),
  licence_state text CHECK (licence_state IN ('granted', 'terminated')),
  transition_log jsonb NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (unit_id, article_id),
  -- Access is never available unless the money is captured and verified.
  CHECK (access_state <> 'available' OR money_state = 'captured'),
  -- A licence exists exactly when money was captured, refunded or reversed.
  CHECK ((licence_state IS NOT NULL) = (money_state IN ('captured', 'refunded', 'reversed')))
);

CREATE TABLE access_windows (
  entitlement_id ums_id PRIMARY KEY REFERENCES entitlements (id),
  state text NOT NULL CHECK (state IN ('not_started', 'running', 'paused', 'ended', 'revoked')),
  started_at timestamptz,
  base_ends_at timestamptz,
  ends_at timestamptz,
  paused_at timestamptz,
  credit_ms integer NOT NULL CHECK (credit_ms >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE links (
  id ums_id PRIMARY KEY,
  entitlement_id ums_id NOT NULL REFERENCES entitlements (id),
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  token_hash ums_sha256 NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  uses integer NOT NULL CHECK (uses >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE access_events (
  id ums_id PRIMARY KEY,
  entitlement_id ums_id NOT NULL REFERENCES entitlements (id),
  link_id ums_id REFERENCES links (id),
  kind text NOT NULL CHECK (kind IN (
    'access_ready', 'link_issued', 'download_completed', 'download_aborted', 'reader_rendered',
    'reader_beacon', 'delivery_failed', 'delivery_restored', 'credit_granted', 'window_ended', 'revoked'
  )),
  at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('system', 'buyer', 'operator')),
  evidence jsonb NOT NULL,
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- One delivery event of a kind per link (nulls are not constrained).
CREATE UNIQUE INDEX access_events_link_kind ON access_events (link_id, kind) WHERE link_id IS NOT NULL;
CREATE TRIGGER access_events_append_only BEFORE UPDATE OR DELETE ON access_events
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER access_events_no_truncate BEFORE TRUNCATE ON access_events
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
