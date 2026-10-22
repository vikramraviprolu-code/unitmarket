-- SBX migration 0007: a link may be bound to the buyer session it was issued in (review 4 M9).
-- Additive and nullable: links issued without a session keep working for any session of the buyer.
-- The serve check lives in domain/delivery (planServe): when session_id is set, another session
-- sees not_found.
ALTER TABLE links ADD COLUMN session_id ums_id;
