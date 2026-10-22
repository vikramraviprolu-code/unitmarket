-- SBX migration 0001: domains, guards, supply side (corridors, publishers, articles, offers).
-- Adapted from AIC_Hackathon_UnitMarket packages/db/migrations/0001_init.sql and 0102_truncate_guards.sql
-- at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX lane 12.
-- Rules (PORT-1, P16): plain SQL, no extension, no now() and no DEFAULT. The application supplies
-- every timestamp from the Clock port. Runs unchanged on PGlite and stock Postgres 15+.

-- Domains mirror the contract primitives (Id, MinorUnits, CurrencyCode, Sha256Hex).
CREATE DOMAIN ums_id AS text
  CHECK (
    length(VALUE) BETWEEN 1 AND 200
    AND VALUE ~ '^\S(.*\S)?$'
    AND VALUE !~ '[[:cntrl:]]'
    AND VALUE !~ '[​-‍⁠﻿]'
  );
CREATE DOMAIN ums_minor AS integer CHECK (VALUE >= 0);
CREATE DOMAIN ums_currency AS text CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN ums_sha256 AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- Append-only guard: UPDATE and DELETE raise (P12).
CREATE FUNCTION ums_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$;

-- TRUNCATE does not fire row-level triggers, so every guarded table also gets a statement-level
-- BEFORE TRUNCATE trigger that refuses unless the session setting ums.allow_reset is 'on'.
-- resetDatabase (packages/db/src/reset.ts) is the only code that sets it, per transaction.
CREATE FUNCTION ums_deny_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('ums.allow_reset', true), '') <> 'on' THEN
    RAISE EXCEPTION 'TRUNCATE on % is not allowed: the table is append-only', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

-- Corridors are data: currency is checked through a foreign key and a trigger on orders, not a
-- literal CHECK (currency = 'USD'). us-usd is the only enabled row in phase 1.
CREATE TABLE corridors (
  id ums_id PRIMARY KEY,
  currency ums_currency NOT NULL,
  minor_units integer NOT NULL CHECK (minor_units IN (0, 2, 3)),
  buyer_countries text[] NOT NULL,
  payee_countries text[] NOT NULL,
  domestic_supported boolean NOT NULL,
  min_charge_minor ums_minor,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE publishers (
  id ums_id PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  country text NOT NULL,
  paypal_merchant_id ums_id UNIQUE,
  payee_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE articles (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  title text NOT NULL,
  abstract text NOT NULL,
  language text NOT NULL,
  topics text[] NOT NULL,
  published_at timestamptz NOT NULL,
  sha256 ums_sha256 NOT NULL,
  content_key text NOT NULL UNIQUE,
  bytes integer NOT NULL CHECK (bytes >= 0),
  mime text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Content bytes by default live here (same on both targets, demo scale). Natural key content_key.
CREATE TABLE content_blobs (
  content_key text PRIMARY KEY,
  sha256 ums_sha256 NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Versioned: a policy or offer keeps its id across versions, so the key is (id, version).
CREATE TABLE access_policies (
  id ums_id NOT NULL,
  version text NOT NULL,
  option text NOT NULL CHECK (option IN ('keep_retrieve', 'online_read')),
  window_ms integer NOT NULL CHECK (window_ms > 0),
  start_rule text NOT NULL CHECK (start_rule = 'payment_verified_and_delivery_ready'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE offers (
  id ums_id NOT NULL,
  version text NOT NULL,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  article_id ums_id NOT NULL REFERENCES articles (id),
  status text NOT NULL CHECK (status IN ('draft', 'authorised', 'withdrawn')),
  currency ums_currency NOT NULL,
  options jsonb NOT NULL,
  affordability jsonb NOT NULL,
  terms_version text NOT NULL,
  rights jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  superseded_by ums_id,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id, version),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE publisher_authorisations (
  id ums_id PRIMARY KEY,
  offer_id ums_id NOT NULL,
  offer_version text NOT NULL,
  authorised_by ums_id NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, offer_version) REFERENCES offers (id, version)
);
CREATE TRIGGER publisher_authorisations_append_only BEFORE UPDATE OR DELETE ON publisher_authorisations
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER publisher_authorisations_no_truncate BEFORE TRUNCATE ON publisher_authorisations
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- Seed rows. The timestamp is a fixed constant because migrations take no clock; it marks seed
-- data, not a real event.
INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
VALUES ('us-usd', 'USD', 2, ARRAY['US'], ARRAY['US'], true, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

INSERT INTO access_policies (id, version, option, window_ms, start_rule, created_at, updated_at) VALUES
  ('keep_retrieve', '1', 'keep_retrieve', 432000000, 'payment_verified_and_delivery_ready', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
  ('online_read', '1', 'online_read', 432000000, 'payment_verified_and_delivery_ready', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
