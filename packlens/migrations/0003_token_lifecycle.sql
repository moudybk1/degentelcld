-- Token lifecycle facts from pump.fun events, used by the "after the pack" view.
-- token_total_supply_raw comes from CreateEvent; completed_at_ms from
-- CompleteEvent (the token left the bonding curve, so later trades happen on
-- venues PackLens does not observe).
ALTER TABLE tokens ADD COLUMN token_total_supply_raw TEXT;
ALTER TABLE tokens ADD COLUMN completed_at_ms INTEGER;
ALTER TABLE tokens ADD COLUMN complete_signature TEXT;
