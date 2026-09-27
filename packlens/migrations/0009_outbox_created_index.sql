-- Retention deletes outbox rows older than 24 hours every hour. Without an index
-- on created_at_ms that DELETE read the whole table in one statement (measured on
-- the live VPS 2026-09-27: 25 s with a cold cache, with the event loop held).
CREATE INDEX event_outbox_created ON event_outbox(created_at_ms);
