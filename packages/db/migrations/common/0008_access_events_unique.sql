-- SBX migration 0008: access_events uniqueness and ordering (Opus review 3, H1 and L8).
-- 0005 made (link_id, kind) unique for every kind, so a second download_completed or a second
-- delivery_failed on one link was dropped: a paused window could never resume and a second outage
-- was never credited. Only link_issued happens once per link. Every other kind is repeatable.
DROP INDEX access_events_link_kind;
CREATE UNIQUE INDEX access_events_link_issued_once ON access_events (link_id, kind)
  WHERE link_id IS NOT NULL AND kind = 'link_issued';
-- Insertion order, so events at the same instant sort by `at, seq` instead of the physical position.
ALTER TABLE access_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX access_events_entitlement_order ON access_events (entitlement_id, at, seq);
