-- Earlier packs by wallet within a time window (co-occurrence patterns on every
-- pack update, and "Earlier packs with these wallets"). A member's entry into a
-- pack lies within that pack's evidence window (at most 20 s before its trigger,
-- at most 40 s after), so queries bound pm.first_entry_time_ms first and then
-- filter packs by trigger time exactly. Without this index every lookup read the
-- wallet's whole pack history (measured on the live VPS 2026-09-26: 70% of CPU,
-- event-loop stalls up to 22 s).
CREATE INDEX pack_members_wallet_time ON pack_members(namespace, wallet, first_entry_time_ms);
