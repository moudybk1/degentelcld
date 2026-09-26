-- packlens: foreign-keys-off
-- Pyth quote price (policy pyth-onchain-v1). Each snapshot holds one price
-- read from Pyth's on-chain SOL/USD price account, stored with timeframe
-- 'tick' (a published price, not a candle). SQLite cannot widen a CHECK
-- constraint in place, so price_snapshots is rebuilt with the documented
-- procedure (sqlite.org/lang_altertable.html#otheralter): the runner turns
-- foreign keys off for this file and runs PRAGMA foreign_key_check before
-- committing. Rows, IDs, and the immutability trigger are unchanged.
CREATE TABLE price_snapshots_new (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  quote_mint TEXT NOT NULL,
  requested_from_ms INTEGER NOT NULL,
  requested_to_ms INTEGER NOT NULL,
  request_started_at_ms INTEGER NOT NULL,
  response_received_at_ms INTEGER NOT NULL,
  available_at_ms INTEGER NOT NULL,
  candles_json TEXT NOT NULL CHECK (json_valid(candles_json)),
  provider_request_id TEXT,
  attempt_id TEXT,
  source TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m' CHECK (timeframe IN ('1m', '5m', 'tick')),
  policy_version TEXT NOT NULL DEFAULT 'nansen-1m-closed-v1',
  UNIQUE (id, namespace)
);
INSERT INTO price_snapshots_new (id, namespace, chain, quote_mint, requested_from_ms, requested_to_ms, request_started_at_ms, response_received_at_ms,
  available_at_ms, candles_json, provider_request_id, attempt_id, source, timeframe, policy_version)
SELECT id, namespace, chain, quote_mint, requested_from_ms, requested_to_ms, request_started_at_ms, response_received_at_ms,
  available_at_ms, candles_json, provider_request_id, attempt_id, source, timeframe, policy_version
FROM price_snapshots;
DROP TABLE price_snapshots;
ALTER TABLE price_snapshots_new RENAME TO price_snapshots;
CREATE INDEX price_snapshots_lookup ON price_snapshots(namespace, quote_mint, available_at_ms);
CREATE TRIGGER price_snapshots_no_update BEFORE UPDATE ON price_snapshots
BEGIN SELECT RAISE(ABORT, 'price snapshots are immutable'); END;
