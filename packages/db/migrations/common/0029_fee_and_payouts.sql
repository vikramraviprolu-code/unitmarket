-- SBX migration 0029: fee on top, ledger split, payouts to publishers (POB-M1, D-089). Owned by SBX lane POB-M1.
-- Forward-only: there is no down step. Plain SQL, no extension, no now() and no DEFAULT (the application supplies
-- every timestamp from the Clock). Runs on PGlite and on stock Postgres 15+.
--
-- What it adds
--   fee_settings            the platform fee on top, in basis points, 0 to 3000. Append-only; the latest row rules.
--   offer_price_parts       the split of a listed price into the publisher's price and the fee, once per offer version
--                           and option. The listed price IS the buyer price (seller price plus fee).
--   order_unit_parts        a copy of the parts at the moment an order is created, so a later fee change never alters a
--                           sale. tax_minor is a reserved column, always 0.
--   ledger_entries          five new kinds: fee, payable, fee_reversal, payable_reversal, payout_adjustment.
--   payouts, payout_items   the payout to a publisher per currency, and the units it pays.
--   adjustment_settlements  netting: refunds booked after a payout are taken off the next payout (no foreign key to the
--                           ledger: it breaks the truncate guard tests).
-- Nothing here reads a PayPal host or holds a credential.

-- ------------------------------------------------------------------------------------------------
-- 1. fee_settings

CREATE TABLE fee_settings (
  id ums_id PRIMARY KEY,
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 3000),
  set_by text NOT NULL CHECK (char_length(set_by) BETWEEN 1 AND 200),
  -- Two settings never share an instant, so "the latest row" is never a tie.
  set_at timestamptz NOT NULL UNIQUE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER fee_settings_append_only BEFORE UPDATE OR DELETE ON fee_settings
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER fee_settings_no_truncate BEFORE TRUNCATE ON fee_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- Seed: 10 percent (D-089), the working assumption of the owners. The timestamp is a fixed constant because migrations
-- take no clock; it marks seed data, not a real event.
INSERT INTO fee_settings (id, fee_bps, set_by, set_at, reason, created_at, updated_at)
VALUES ('rls_fee_seed', 1000, 'seed', '1970-01-01T00:00:00Z', 'seed: 10 percent on top (D-089)', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

-- ------------------------------------------------------------------------------------------------
-- 2. offer_price_parts

CREATE TABLE offer_price_parts (
  offer_id ums_id NOT NULL,
  offer_version text NOT NULL,
  option text NOT NULL CHECK (option IN ('keep_retrieve', 'online_read')),
  seller_minor ums_minor NOT NULL CHECK (seller_minor >= 1),
  fee_minor ums_minor NOT NULL,
  tax_minor ums_minor NOT NULL CHECK (tax_minor = 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 3000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (offer_id, offer_version, option),
  FOREIGN KEY (offer_id, offer_version) REFERENCES offers (id, version)
);

-- Seller price plus fee plus tax must equal the listed price of that option: the number every quote, approval and order
-- already reads.
CREATE FUNCTION ums_offer_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  listed numeric;
BEGIN
  SELECT (e ->> 'price_minor')::numeric INTO listed
    FROM offers o CROSS JOIN LATERAL jsonb_array_elements(o.options) e
   WHERE o.id = NEW.offer_id AND o.version = NEW.offer_version AND e ->> 'option' = NEW.option;
  IF listed IS NULL THEN
    RAISE EXCEPTION 'offer % version % has no option %', NEW.offer_id, NEW.offer_version, NEW.option;
  END IF;
  IF listed <> NEW.seller_minor::numeric + NEW.fee_minor + NEW.tax_minor THEN
    RAISE EXCEPTION 'parts % + % + % of offer % version % option % do not add up to the listed price %',
      NEW.seller_minor, NEW.fee_minor, NEW.tax_minor, NEW.offer_id, NEW.offer_version, NEW.option, listed;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offer_price_parts_guard BEFORE INSERT ON offer_price_parts
  FOR EACH ROW EXECUTE FUNCTION ums_offer_parts_guard();
CREATE TRIGGER offer_price_parts_append_only BEFORE UPDATE OR DELETE ON offer_price_parts
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER offer_price_parts_no_truncate BEFORE TRUNCATE ON offer_price_parts
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- 3. order_unit_parts

CREATE TABLE order_unit_parts (
  unit_id ums_id PRIMARY KEY REFERENCES order_units (id),
  seller_minor ums_minor NOT NULL CHECK (seller_minor >= 1),
  fee_minor ums_minor NOT NULL,
  tax_minor ums_minor NOT NULL CHECK (tax_minor = 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE FUNCTION ums_unit_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  amount numeric;
BEGIN
  SELECT amount_minor INTO amount FROM order_units WHERE id = NEW.unit_id;
  IF amount IS NOT NULL AND amount <> NEW.seller_minor::numeric + NEW.fee_minor + NEW.tax_minor THEN
    RAISE EXCEPTION 'parts % + % + % of unit % do not add up to its amount %',
      NEW.seller_minor, NEW.fee_minor, NEW.tax_minor, NEW.unit_id, amount;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_unit_parts_guard BEFORE INSERT ON order_unit_parts
  FOR EACH ROW EXECUTE FUNCTION ums_unit_parts_guard();
CREATE TRIGGER order_unit_parts_append_only BEFORE UPDATE OR DELETE ON order_unit_parts
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER order_unit_parts_no_truncate BEFORE TRUNCATE ON order_unit_parts
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- 4. ledger_entries: five new kinds

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ledger_entries'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%commission_reversal%')
  LOOP
    EXECUTE format('ALTER TABLE ledger_entries DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN (
  'sale', 'paypal_fee', 'platform_fee', 'refund', 'reversal', 'commission_reversal',
  'fee', 'payable', 'fee_reversal', 'payable_reversal', 'payout_adjustment'
));
-- The kinds that belong to one refund carry its id (one row per refund id); every other kind carries none.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_refund_id_pairing CHECK (
  (kind IN ('refund', 'commission_reversal', 'fee_reversal', 'payable_reversal', 'payout_adjustment'))
  = (refund_id IS NOT NULL)
);
-- A new kind is a money fact: never zero.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_split_amount CHECK (
  kind NOT IN ('fee', 'payable', 'fee_reversal', 'payable_reversal', 'payout_adjustment') OR amount_minor > 0
);
CREATE INDEX ledger_entries_split_kinds ON ledger_entries (unit_id, kind)
  WHERE kind IN ('fee', 'payable', 'fee_reversal', 'payable_reversal', 'payout_adjustment');

-- The guard of 0004 plus: a reversal never exceeds what it reverses (the unit row is locked first, so two refunds
-- on one capture are checked one after the other).
CREATE OR REPLACE FUNCTION ums_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_currency text;
  sale_total numeric;
  refunded_total numeric;
  base_total numeric;
  done_total numeric;
BEGIN
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
  ELSIF NEW.kind IN ('fee_reversal', 'payable_reversal') THEN
    SELECT coalesce(sum(amount_minor), 0) INTO base_total
      FROM ledger_entries WHERE capture_id = NEW.capture_id
       AND kind = CASE NEW.kind WHEN 'fee_reversal' THEN 'fee' ELSE 'payable' END;
    SELECT coalesce(sum(amount_minor), 0) INTO done_total
      FROM ledger_entries WHERE capture_id = NEW.capture_id AND kind = NEW.kind;
    IF done_total + NEW.amount_minor > base_total THEN
      RAISE EXCEPTION '% of % would exceed the % booked for capture %', NEW.kind, done_total + NEW.amount_minor, base_total, NEW.capture_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------------------------------------
-- 5. payouts

CREATE TABLE payouts (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  currency ums_currency NOT NULL,
  -- One payout is at most 100000000 minor units (PAYOUT_MAX_MINOR); a larger sum is cut into several payouts.
  amount_minor ums_minor NOT NULL CHECK (amount_minor <= 100000000),
  state text NOT NULL CHECK (state IN ('due', 'sending', 'sent', 'confirmed', 'failed', 'cancelled')),
  environment text NOT NULL CHECK (environment IN ('dryrun', 'sandbox')),
  idempotency_key text NOT NULL UNIQUE,
  -- Where the payout goes: the legacy payee of the publisher when the payout was created (until the verified link of POB-P1).
  payee_merchant_id text NOT NULL CHECK (char_length(payee_merchant_id) BETWEEN 1 AND 200),
  provider_ref text CHECK (provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 200),
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 200),
  sending_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (idempotency_key = 'umsP-' || id),
  -- A payout of 0 exists only when it was netted against refunds: confirmed at once and never sent.
  CHECK (amount_minor > 0 OR (state = 'confirmed' AND provider_ref = 'NETTED-' || id)),
  CHECK (state NOT IN ('sent', 'confirmed') OR provider_ref IS NOT NULL),
  CHECK (state <> 'failed' OR (failure_reason IS NOT NULL AND failed_at IS NOT NULL)),
  CHECK (state NOT IN ('sending', 'sent', 'failed') OR sending_at IS NOT NULL)
);
CREATE INDEX payouts_state ON payouts (state, created_at, id);
CREATE INDEX payouts_publisher ON payouts (publisher_id, currency, state);

-- A payout starts due (or netted and confirmed). After that only these moves exist, so a sending payout can be neither
-- replaced nor cancelled, and a sent one cannot go back:
--   due -> sending | cancelled      sending -> sent | confirmed | failed
--   sent -> confirmed               failed -> cancelled
CREATE FUNCTION ums_payout_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'due' AND NEW.sending_at IS NULL AND NEW.failed_at IS NULL
     AND NEW.provider_ref IS NULL AND NEW.failure_reason IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'confirmed' AND NEW.amount_minor = 0 THEN
    RETURN NEW; -- netted: the CHECK holds the rest
  END IF;
  RAISE EXCEPTION 'payout % can only be created due (or netted and confirmed), not %', NEW.id, NEW.state;
END;
$$;
CREATE TRIGGER payouts_insert_guard BEFORE INSERT ON payouts
  FOR EACH ROW EXECUTE FUNCTION ums_payout_insert_guard();

CREATE FUNCTION ums_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.publisher_id, NEW.currency, NEW.amount_minor, NEW.environment, NEW.idempotency_key,
      NEW.payee_merchant_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.publisher_id, OLD.currency, OLD.amount_minor, OLD.environment, OLD.idempotency_key,
      OLD.payee_merchant_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payout % is fixed except for its state and what the state needs', OLD.id;
  END IF;
  IF NOT (
       (OLD.state = 'due' AND NEW.state IN ('sending', 'cancelled'))
    OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'confirmed', 'failed'))
    OR (OLD.state = 'sent' AND NEW.state = 'confirmed')
    OR (OLD.state = 'failed' AND NEW.state = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'payout % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'payout % keeps the provider reference it was given', OLD.id;
  END IF;
  IF OLD.failure_reason IS NOT NULL AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
    RAISE EXCEPTION 'payout % keeps the failure reason it was given', OLD.id;
  END IF;
  IF OLD.sending_at IS NOT NULL AND NEW.sending_at IS DISTINCT FROM OLD.sending_at THEN
    RAISE EXCEPTION 'payout % keeps the time it started sending', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payouts_guard BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION ums_payout_guard();
CREATE TRIGGER payouts_no_delete BEFORE DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION ums_deny_delete();
CREATE TRIGGER payouts_no_truncate BEFORE TRUNCATE ON payouts
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- 6. payout_items: the units a payout pays. A unit is in at most one live payout.

CREATE TABLE payout_items (
  payout_id ums_id NOT NULL REFERENCES payouts (id),
  order_unit_id ums_id NOT NULL REFERENCES order_units (id),
  seller_minor ums_minor NOT NULL CHECK (seller_minor >= 1),
  live boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (payout_id, order_unit_id)
);
CREATE UNIQUE INDEX payout_items_one_live_per_unit ON payout_items (order_unit_id) WHERE live;

-- An item is released (live true to false) only when its payout is cancelled, and never switched on again.
CREATE FUNCTION ums_payout_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payout_id, NEW.order_unit_id, NEW.seller_minor, NEW.created_at)
     IS DISTINCT FROM (OLD.payout_id, OLD.order_unit_id, OLD.seller_minor, OLD.created_at) THEN
    RAISE EXCEPTION 'a payout item changes only by being released';
  END IF;
  IF NOT (OLD.live AND NOT NEW.live) THEN
    RAISE EXCEPTION 'a payout item can only be released, once';
  END IF;
  IF (SELECT state FROM payouts WHERE id = OLD.payout_id) IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'the items of payout % are released only when it is cancelled', OLD.payout_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_items_guard BEFORE UPDATE ON payout_items
  FOR EACH ROW EXECUTE FUNCTION ums_payout_item_guard();
CREATE TRIGGER payout_items_no_delete BEFORE DELETE ON payout_items
  FOR EACH ROW EXECUTE FUNCTION ums_deny_delete();
CREATE TRIGGER payout_items_no_truncate BEFORE TRUNCATE ON payout_items
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- ------------------------------------------------------------------------------------------------
-- 7. adjustment_settlements: a refund booked after a payout is taken off a later payout. No foreign key to the ledger.

CREATE TABLE adjustment_settlements (
  payout_id ums_id NOT NULL REFERENCES payouts (id),
  -- The ledger entry (kind payout_adjustment) this settles. Not a foreign key.
  adjustment_entry_id ums_id NOT NULL,
  amount_minor ums_minor NOT NULL CHECK (amount_minor >= 1),
  live boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (payout_id, adjustment_entry_id)
);
CREATE INDEX adjustment_settlements_entry ON adjustment_settlements (adjustment_entry_id) WHERE live;

CREATE FUNCTION ums_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payout_id, NEW.adjustment_entry_id, NEW.amount_minor, NEW.created_at)
     IS DISTINCT FROM (OLD.payout_id, OLD.adjustment_entry_id, OLD.amount_minor, OLD.created_at) THEN
    RAISE EXCEPTION 'a settlement changes only by being released';
  END IF;
  IF NOT (OLD.live AND NOT NEW.live) THEN
    RAISE EXCEPTION 'a settlement can only be released, once';
  END IF;
  IF (SELECT state FROM payouts WHERE id = OLD.payout_id) IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'the settlements of payout % are released only when it is cancelled', OLD.payout_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER adjustment_settlements_guard BEFORE UPDATE ON adjustment_settlements
  FOR EACH ROW EXECUTE FUNCTION ums_settlement_guard();
CREATE TRIGGER adjustment_settlements_no_delete BEFORE DELETE ON adjustment_settlements
  FOR EACH ROW EXECUTE FUNCTION ums_deny_delete();
CREATE TRIGGER adjustment_settlements_no_truncate BEFORE TRUNCATE ON adjustment_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- The amount of a payout equals its items minus its live settlements, checked when the transaction commits (the rows
-- are inserted after the payout in the same transaction). Items are never edited, so this holds for the life of the row.
CREATE FUNCTION ums_payout_amount_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  items numeric;
  settled numeric;
BEGIN
  SELECT coalesce(sum(seller_minor), 0) INTO items FROM payout_items WHERE payout_id = NEW.id;
  SELECT coalesce(sum(amount_minor), 0) INTO settled FROM adjustment_settlements WHERE payout_id = NEW.id AND live;
  IF NEW.amount_minor <> items - settled THEN
    RAISE EXCEPTION 'payout % is % but its items are % less settlements %', NEW.id, NEW.amount_minor, items, settled;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payouts_amount_check AFTER INSERT ON payouts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ums_payout_amount_check();
