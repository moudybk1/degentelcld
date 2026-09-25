-- Quote-price policy provenance. The P0 baseline is Nansen OHLCV 1m closed
-- candles (nansen-1m-closed-v1). A documented fallback uses 5m closed candles
-- (nansen-5m-closed-v1) because 1m WSOL queries time out upstream. Every
-- snapshot records which candle length and policy produced it.
ALTER TABLE price_snapshots ADD COLUMN timeframe TEXT NOT NULL DEFAULT '1m' CHECK (timeframe IN ('1m', '5m'));
ALTER TABLE price_snapshots ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'nansen-1m-closed-v1';
