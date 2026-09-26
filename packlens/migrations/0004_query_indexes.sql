-- Indexes for queries that otherwise scan every stored trade.
-- trade_events_time: latest-event lookup in /api/status and the retention
--   cutoff (event_time_ms < ?) per live namespace.
-- trade_events_price_snapshot: the retention check for unreferenced price
--   snapshots, and the foreign-key check SQLite runs when a snapshot is deleted.
-- packs_trigger_event: the retention check that keeps pack trigger events, and
--   the foreign-key check SQLite runs when a trade event is deleted.
CREATE INDEX trade_events_time ON trade_events(namespace, event_time_ms);
CREATE INDEX trade_events_price_snapshot ON trade_events(namespace, price_snapshot_id);
CREATE INDEX packs_trigger_event ON packs(namespace, trigger_event_id);
