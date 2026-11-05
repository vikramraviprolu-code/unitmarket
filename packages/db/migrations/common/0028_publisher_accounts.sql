-- SBX migration 0028: publisher accounts (POB-P1, decision D-089). Owned by SBX lane POB-P1.
-- Forward-only: there is no down step. Adds three tables and widens one CHECK; no change to publishers, orders,
-- the ledger, units, approvals or the Supabase set (the policy for the new tables is a listed follow-up, Supabase
-- is unused, D-049). System only: the app reads and writes them with the server's own connection.
-- HARD PREREQUISITE: Supabase row level security for publisher_accounts and publisher_invites (and the grants
-- that keep the browser roles off them) must exist before any Supabase use; until then they are reachable only
-- by the server's own connection, and the hash columns must never be exposed through a browser facing role.
-- No defaults: the writer states every value.
--
-- publisher_accounts: the sign in of a publisher who claimed an account with an invite code. One row per
-- publisher, same shape as buyer_accounts (0016): a lower case username of 3 to 30 characters, the scrypt string
-- of the passcode code, the consecutive failure count and the lock. No email address is stored here.
CREATE TABLE publisher_accounts (
  publisher_id ums_id PRIMARY KEY REFERENCES publishers (id),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,30}$'),
  password_hash text NOT NULL CHECK (length(password_hash) > 0),
  failed_attempts integer NOT NULL CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- publisher_invites: the one time code an operator hands a new publisher. Only the SHA-256 of the code is
-- stored (never the code). At most one live invite per publisher: a live invite is one that is neither used nor
-- voided, and issuing a new one voids the old (voided_at). expires_at is 7 days after created_at, set by the writer.
-- The row changes in place when it is used or voided, so it has updated_at like the other mutable tables.
CREATE TABLE publisher_invites (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  code_hash ums_sha256 NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  voided_at timestamptz,
  created_by text NOT NULL CHECK (length(created_by) > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX publisher_invites_one_live ON publisher_invites (publisher_id)
  WHERE used_at IS NULL AND voided_at IS NULL;

-- publisher_paypal_links: the email of the publisher's own PayPal Business account (UnitMarket never creates a
-- PayPal account). requested until an operator verifies it; verified exactly when both verified_by and
-- verified_at are set. A change by the publisher returns it to requested and clears both.
CREATE TABLE publisher_paypal_links (
  publisher_id ums_id PRIMARY KEY REFERENCES publishers (id),
  paypal_email text NOT NULL CHECK (length(paypal_email) BETWEEN 3 AND 254),
  state text NOT NULL CHECK (state IN ('requested', 'verified')),
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'verified') = (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);

-- publisher_agreements (0015): a publisher can now accept the terms with a click, method publisher_accepted.
-- The seeded_demo method stays, and the table stays append-only.
ALTER TABLE publisher_agreements DROP CONSTRAINT publisher_agreements_method_check;
ALTER TABLE publisher_agreements ADD CONSTRAINT publisher_agreements_method_check
  CHECK (method IN ('seeded_demo', 'publisher_accepted'));
