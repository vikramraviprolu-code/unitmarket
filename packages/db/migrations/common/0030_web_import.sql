-- SBX migration 0030: the web import (POB-I1, D-089). Owned by SBX lane POB-I1.
-- Forward-only: there is no down step. Adds three tables and one helper function; no existing table, row or
-- trigger changes. No defaults: every column is given by the caller, every time, from the caller's clock.
--
-- publisher_domains: a web address a publisher says it controls. `pending` until the proof is found (a
-- <meta name="unitmarket-verify"> tag on the front page or the file /.well-known/unitmarket-verify.txt);
-- then `verified`. Only the hash of the token is kept. A host has one verified owner. The row moves from
-- pending to verified and never back; the host and the owner never change.
CREATE TABLE publisher_domains (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  host text NOT NULL CHECK (
    char_length(host) BETWEEN 4 AND 253
    AND host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND host !~ '\.(0x[0-9a-f]*|[0-9]+)$'
  ),
  token_hash ums_sha256 NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'verified')),
  requested_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (publisher_id, host),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX publisher_domains_one_verified_owner ON publisher_domains (host) WHERE state = 'verified';

CREATE FUNCTION publisher_domains_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.host IS DISTINCT FROM OLD.host OR NEW.publisher_id IS DISTINCT FROM OLD.publisher_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publisher_domains: host, publisher and creation time never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'verified' AND (NEW.state <> 'verified' OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.requested_at IS DISTINCT FROM OLD.requested_at) THEN
    RAISE EXCEPTION 'publisher_domains: a verified domain does not go back'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER publisher_domains_guard BEFORE UPDATE ON publisher_domains
  FOR EACH ROW EXECUTE FUNCTION publisher_domains_guard();

-- import_batches: one run over one source. `queued` when the publisher begins (after the proof was found
-- again), `running` while the job reads the source, then `done`, `failed` or `interrupted` (a restart, the
-- 120 second deadline, the switch turned off). At most one batch per publisher is queued or running.
-- done counts items that were looked at (staged, refused or already known); refused and existing are parts
-- of done. A batch that has ended keeps its state and counts: only the attestation of rights may be added.
CREATE TABLE import_batches (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  source_host text NOT NULL CHECK (char_length(source_host) BETWEEN 4 AND 253),
  source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 12 AND 2048),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'interrupted')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 60),
  total integer NOT NULL CHECK (total BETWEEN 0 AND 100),
  done integer NOT NULL CHECK (done >= 0),
  refused integer NOT NULL CHECK (refused >= 0),
  existing integer NOT NULL CHECK (existing >= 0),
  changed integer NOT NULL CHECK (changed >= 0),
  attested_at timestamptz,
  attestation_version text CHECK (attestation_version IS NULL OR char_length(attestation_version) BETWEEN 1 AND 40),
  created_by ums_id NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK (done <= total),
  CHECK (refused <= done AND existing <= done AND changed <= done),
  CHECK ((attested_at IS NULL) = (attestation_version IS NULL))
);
CREATE UNIQUE INDEX import_batches_one_active ON import_batches (publisher_id) WHERE state IN ('queued', 'running');
CREATE INDEX import_batches_queue_idx ON import_batches (created_at) WHERE state = 'queued';

CREATE FUNCTION import_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.publisher_id IS DISTINCT FROM OLD.publisher_id OR NEW.source_host IS DISTINCT FROM OLD.source_host
     OR NEW.source_url IS DISTINCT FROM OLD.source_url OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'import_batches: publisher, source and creation never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('done', 'failed', 'interrupted') AND (
       NEW.state IS DISTINCT FROM OLD.state OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.total IS DISTINCT FROM OLD.total OR NEW.done IS DISTINCT FROM OLD.done
       OR NEW.refused IS DISTINCT FROM OLD.refused OR NEW.existing IS DISTINCT FROM OLD.existing
       OR NEW.changed IS DISTINCT FROM OLD.changed OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'import_batches: a batch that has ended stays as it ended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER import_batches_guard BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_batches_guard();

-- import_topics_ok: at most 8 topics, each 1 to 40 characters (the limits of the feed reader). A function
-- because a CHECK cannot hold a subquery.
CREATE FUNCTION import_topics_ok(t text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT t IS NOT NULL AND cardinality(t) <= 8
     AND NOT EXISTS (SELECT 1 FROM unnest(t) AS x WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 40);
$fn$;

-- import_items: what the job read, waiting for the publisher. Nothing here is for sale: the catalogue
-- changes only when the publisher publishes (a new article and offer, in one transaction per item).
-- `content_ref` is the key of the hosted copy in content_blobs (text, or the picture itself); for a picture
-- item `image_ref` is the same key. `price_minor` is the publisher's own price, `source_price_minor` the
-- proposal the source gave (after the price bounds were applied). A refused item says why and keeps its key, so a re-import skips it.
-- offer_id has no foreign key: offers are keyed by id and version.
CREATE TABLE import_items (
  id ums_id PRIMARY KEY,
  batch_id ums_id NOT NULL REFERENCES import_batches (id),
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('article', 'image')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
  language text NOT NULL CHECK (char_length(language) BETWEEN 2 AND 16),
  topics text[] NOT NULL CHECK (import_topics_ok(topics)),
  price_minor integer CHECK (price_minor IS NULL OR price_minor >= 1),
  source_price_minor integer CHECK (source_price_minor IS NULL OR source_price_minor >= 1),
  currency ums_currency,
  image_ref text CHECK (image_ref IS NULL OR char_length(image_ref) BETWEEN 1 AND 300),
  content_ref text CHECK (content_ref IS NULL OR char_length(content_ref) BETWEEN 1 AND 300),
  content_sha256 ums_sha256,
  content_mime text CHECK (content_mime IS NULL OR content_mime IN ('text/plain', 'image/jpeg', 'image/png', 'image/webp')),
  content_bytes integer CHECK (content_bytes IS NULL OR content_bytes BETWEEN 0 AND 2097152),
  source_published_at timestamptz,
  state text NOT NULL CHECK (state IN ('staged', 'hidden', 'published', 'refused')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  article_id ums_id REFERENCES articles (id),
  offer_id ums_id,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (publisher_id, source_key),
  CHECK ((state = 'refused') = (reason IS NOT NULL)),
  CHECK (state <> 'published' OR (article_id IS NOT NULL AND offer_id IS NOT NULL)),
  CHECK (state = 'published' OR (article_id IS NULL AND offer_id IS NULL)),
  CHECK (state = 'refused' OR (content_ref IS NOT NULL AND content_sha256 IS NOT NULL
         AND content_mime IS NOT NULL AND content_bytes IS NOT NULL))
);
CREATE INDEX import_items_batch_idx ON import_items (batch_id, state);

CREATE FUNCTION import_items_owner() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  owner_of_batch text;
  owner_of_article text;
BEGIN
  SELECT b.publisher_id INTO owner_of_batch FROM import_batches b WHERE b.id = NEW.batch_id;
  IF owner_of_batch IS DISTINCT FROM NEW.publisher_id THEN
    RAISE EXCEPTION 'import_items: an item belongs to the publisher of its batch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.article_id IS NOT NULL THEN
    SELECT a.publisher_id INTO owner_of_article FROM articles a WHERE a.id = NEW.article_id;
    IF owner_of_article IS DISTINCT FROM NEW.publisher_id THEN
      RAISE EXCEPTION 'import_items: the article of a published item has the publisher of the item'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.publisher_id IS DISTINCT FROM OLD.publisher_id
       OR NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.image_ref IS DISTINCT FROM OLD.image_ref OR NEW.content_ref IS DISTINCT FROM OLD.content_ref
       OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR NEW.content_mime IS DISTINCT FROM OLD.content_mime
       OR NEW.content_bytes IS DISTINCT FROM OLD.content_bytes
       OR NEW.source_price_minor IS DISTINCT FROM OLD.source_price_minor
       OR NEW.source_published_at IS DISTINCT FROM OLD.source_published_at
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'import_items: the key, the kind, the hosted copy and the source facts never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state IN ('published', 'refused') AND (
         NEW.state IS DISTINCT FROM OLD.state OR NEW.title IS DISTINCT FROM OLD.title
         OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.language IS DISTINCT FROM OLD.language
         OR NEW.topics IS DISTINCT FROM OLD.topics OR NEW.price_minor IS DISTINCT FROM OLD.price_minor
         OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.article_id IS DISTINCT FROM OLD.article_id
         OR NEW.offer_id IS DISTINCT FROM OLD.offer_id) THEN
      RAISE EXCEPTION 'import_items: a published or refused item is final'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER import_items_owner BEFORE INSERT OR UPDATE ON import_items
  FOR EACH ROW EXECUTE FUNCTION import_items_owner();
