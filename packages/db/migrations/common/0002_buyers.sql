-- SBX migration 0002: buyers, consents, identity links, sessions. Owned by SBX lane 12.

CREATE TABLE buyers (
  id ums_id PRIMARY KEY,
  display_name text NOT NULL,
  auth_subject text NOT NULL UNIQUE,
  country text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE consents (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  kind text NOT NULL,
  text_version text NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE identity_links (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  provider text NOT NULL,
  subject_hash ums_sha256 NOT NULL,
  consent_id ums_id NOT NULL REFERENCES consents (id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- actor_id is the buyer, publisher or operator id. The CSRF token is stored hashed only.
CREATE TABLE sessions (
  id ums_id PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('buyer', 'publisher', 'operator')),
  actor_id ums_id NOT NULL,
  csrf_token_hash ums_sha256 NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
