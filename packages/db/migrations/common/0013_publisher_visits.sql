-- SBX migration 0013: publisher_visits (PUB-E1, "Since your last visit"). Owned by SBX lane PUB-E1.
-- Forward-only: there is no down step. Nothing existing is changed or deleted; one new table.
--
-- One row per publisher: a cursor, not a history, so it may be updated (no append-only guard). The
-- application writes it with the injected clock; there is no default and no database time function.
--   since_at      the instant "since your last visit" counts from; NULL until a second visit
--   last_seen_at  the last time the publisher opened the home page
CREATE TABLE publisher_visits (
  publisher_id ums_id PRIMARY KEY REFERENCES publishers (id),
  since_at timestamptz,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
