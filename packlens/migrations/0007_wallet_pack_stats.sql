-- Repeat wallets. wallet_pack_stats counts, per namespace, how many packs each
-- wallet joined, kept current by a trigger on pack_members so the Repeat
-- wallets page and enrichment selection never aggregate the member table.
-- Member upserts that hit an existing (pack, wallet) row run UPDATE triggers,
-- not this INSERT trigger, so a wallet is counted once per pack.
CREATE TABLE wallet_pack_stats (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  wallet TEXT NOT NULL,
  packs INTEGER NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, wallet)
);
CREATE INDEX wallet_pack_stats_rank ON wallet_pack_stats(namespace, packs DESC, last_seen_ms DESC);
CREATE INDEX wallet_pack_stats_recent ON wallet_pack_stats(namespace, last_seen_ms);

INSERT INTO wallet_pack_stats (namespace, wallet, packs, first_seen_ms, last_seen_ms)
SELECT namespace, wallet, COUNT(*), MIN(first_entry_time_ms), MAX(first_entry_time_ms) FROM pack_members GROUP BY namespace, wallet;

CREATE TRIGGER pack_members_wallet_stats AFTER INSERT ON pack_members
BEGIN
  INSERT OR IGNORE INTO wallet_pack_stats (namespace, wallet, packs, first_seen_ms, last_seen_ms)
    VALUES (NEW.namespace, NEW.wallet, 0, NEW.first_entry_time_ms, NEW.first_entry_time_ms);
  UPDATE wallet_pack_stats
     SET packs = packs + 1,
         first_seen_ms = MIN(first_seen_ms, NEW.first_entry_time_ms),
         last_seen_ms = MAX(last_seen_ms, NEW.first_entry_time_ms)
   WHERE namespace = NEW.namespace AND wallet = NEW.wallet;
END;

-- Latest job per subject (panel states on pack and wallet pages, repeat-wallet
-- selection). Without it every panel scans the whole job table, which grows by
-- thousands of rows a day once Nansen runs continuously.
CREATE INDEX jobs_subject ON jobs(namespace, type, subject, enqueued_at_ms DESC);

-- Extra Nansen profiles per pack, beyond the spec's first three initial
-- members: the largest buyer and the member seen in the most earlier packs.
-- JSON array of {wallet, reason: "largest_buyer" | "repeat_wallet", earlierPacks}.
ALTER TABLE pack_enrichment ADD COLUMN extra_profile_wallets_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(extra_profile_wallets_json));
