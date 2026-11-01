-- SBX migration 0016: buyer accounts (ID-ACCOUNTS, owner brief 31 Oct 2026). Owned by SBX lane ID-ACCOUNTS.
-- Forward-only: there is no down step. Adds one table and nothing else: no change to buyers, consents,
-- sessions or any other table, and none to the Supabase set (the policy for the new table is a listed
-- follow-up, Supabase is unused, D-049). System only: the app reads and writes it with the server's own
-- connection; there is no buyer or publisher policy because a buyer never reads this table directly.
--
-- buyer_accounts: the sign in of a buyer who made an account with a username and a password. One row per
-- buyer. The username is lower case, 3 to 30 of letters, digits, dot, dash and underscore, and unique. No
-- email address is stored anywhere. password_hash is the scrypt string of the passcode code (never the
-- password). failed_attempts counts consecutive failures; locked_until is set while the account is locked.
-- No defaults: the writer states every value. Unlike the append-only tables this one is updated in place,
-- because the lock state and the hash change.
CREATE TABLE buyer_accounts (
  buyer_id ums_id PRIMARY KEY REFERENCES buyers (id),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,30}$'),
  password_hash text NOT NULL CHECK (length(password_hash) > 0),
  failed_attempts integer NOT NULL CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
