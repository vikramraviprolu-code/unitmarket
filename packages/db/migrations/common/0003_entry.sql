-- SBX migration 0003: briefs, proposals, quotes. Owned by SBX lane 12.

CREATE TABLE briefs (
  id ums_id PRIMARY KEY,
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  raw_text text NOT NULL,
  structured jsonb NOT NULL,
  version text NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE proposals (
  id ums_id PRIMARY KEY,
  brief_id ums_id NOT NULL REFERENCES briefs (id),
  buyer_id ums_id NOT NULL REFERENCES buyers (id),
  items jsonb NOT NULL,
  fit jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE quotes (
  id ums_id PRIMARY KEY,
  buyer_id ums_id REFERENCES buyers (id),
  offer_id ums_id NOT NULL,
  offer_version text NOT NULL,
  option text NOT NULL CHECK (option IN ('keep_retrieve', 'online_read')),
  price_minor ums_minor NOT NULL,
  currency ums_currency NOT NULL,
  corridor_id ums_id NOT NULL REFERENCES corridors (id),
  source text NOT NULL CHECK (source IN ('direct', 'wordpress', 'discovery')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, offer_version) REFERENCES offers (id, version)
);
