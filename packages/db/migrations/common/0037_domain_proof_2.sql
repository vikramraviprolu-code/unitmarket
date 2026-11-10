-- SBX migration 0037: web import site proof, round 2 (DOMAIN-PROOF-2, docs/specs/catalogue-domain-proof-2.md, D-116).
-- Forward-only: there is no down step. Additive: one new table, three new nullable columns, two CHECKs replaced to
-- admit the new state, one guard function replaced. No default, no now(). The number is 0037 (0035 is the import switch,
-- 0036 is reserved by D-115 for the import currency per batch; the runner applies unapplied files in name order).
--
-- publisher_proof_codes: ONE permanent verification code per publisher. It is a public value (it sits on the
-- publisher's own public web pages) and is kept in clear so the publisher can see it again; it is never logged or put
-- in an audit row. A code belongs to one publisher, and never changes once written.
CREATE TABLE publisher_proof_codes (
  publisher_id ums_id PRIMARY KEY REFERENCES publishers (id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{16,128}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE FUNCTION publisher_proof_codes_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.publisher_id IS DISTINCT FROM OLD.publisher_id OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publisher_proof_codes: a proof code never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER publisher_proof_codes_guard BEFORE UPDATE ON publisher_proof_codes
  FOR EACH ROW EXECUTE FUNCTION publisher_proof_codes_guard();

-- publisher_domains: who verified the address (proof: the code was found; operator: an operator vouched, with the
-- second factor and a reason), and the new soft state `removed`. Old verified rows keep verified_by NULL (read as proof).
ALTER TABLE publisher_domains
  ADD COLUMN verified_by text CHECK (verified_by IS NULL OR verified_by IN ('proof', 'operator')),
  ADD COLUMN vouched_by ums_id,
  ADD COLUMN vouch_reason text;

ALTER TABLE publisher_domains DROP CONSTRAINT publisher_domains_state_check;
ALTER TABLE publisher_domains ADD CONSTRAINT publisher_domains_state_check
  CHECK (state IN ('pending', 'verified', 'removed'));
-- verified needs its time, pending has none; a removed row keeps the time it had (history).
ALTER TABLE publisher_domains DROP CONSTRAINT publisher_domains_check;
ALTER TABLE publisher_domains ADD CONSTRAINT publisher_domains_verified_at_check
  CHECK ((state = 'verified' AND verified_at IS NOT NULL) OR (state = 'pending' AND verified_at IS NULL) OR state = 'removed');
ALTER TABLE publisher_domains ADD CONSTRAINT publisher_domains_verified_by_state_check
  CHECK (verified_by IS NULL OR state IN ('verified', 'removed'));
ALTER TABLE publisher_domains ADD CONSTRAINT publisher_domains_vouch_check
  CHECK (CASE WHEN verified_by = 'operator'
              THEN vouched_by IS NOT NULL AND vouch_reason IS NOT NULL AND char_length(vouch_reason) BETWEEN 3 AND 200
              ELSE vouched_by IS NULL AND vouch_reason IS NULL END);

-- The one verified owner index only covers state = 'verified', so a removed row frees the host without a change.
-- The guard: host, publisher and creation time never change. A verified row may become removed and nothing else may
-- change on it. A removed row goes back through pending (never straight to verified).
CREATE OR REPLACE FUNCTION publisher_domains_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.host IS DISTINCT FROM OLD.host OR NEW.publisher_id IS DISTINCT FROM OLD.publisher_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publisher_domains: host, publisher and creation time never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'verified' AND (NEW.state NOT IN ('verified', 'removed') OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.vouched_by IS DISTINCT FROM OLD.vouched_by
     OR NEW.vouch_reason IS DISTINCT FROM OLD.vouch_reason) THEN
    RAISE EXCEPTION 'publisher_domains: a verified domain does not go back'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'removed' AND NEW.state = 'verified' THEN
    RAISE EXCEPTION 'publisher_domains: a removed domain is proved again from pending'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
