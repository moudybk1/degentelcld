-- PackLens initial schema (blueprint §10.1, §10.2, §17.6).
-- Namespaces isolate live, fixture, and replay data. Composite foreign keys
-- keep every reference inside its own namespace.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE namespaces (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'live', 'replay')),
  created_at_ms INTEGER NOT NULL,
  dataset_hash TEXT,
  label TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
  first_observed_event_ms INTEGER,
  watermark_ms INTEGER,
  CHECK (
    (mode = 'live' AND id LIKE 'live:%') OR
    (mode = 'fixture' AND id LIKE 'fixture:%') OR
    (mode = 'replay' AND id LIKE 'replay:%')
  )
);

CREATE TABLE price_snapshots (
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
  UNIQUE (id, namespace)
);
CREATE INDEX price_snapshots_lookup ON price_snapshots(namespace, quote_mint, available_at_ms);
CREATE TRIGGER price_snapshots_no_update BEFORE UPDATE ON price_snapshots
BEGIN SELECT RAISE(ABORT, 'price snapshots are immutable'); END;

CREATE TABLE trade_events (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  event_id TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 0),
  slot INTEGER NOT NULL,
  event_time_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  normalized_at_ms INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('live', 'backfill', 'replay', 'fixture')),
  valuation_status TEXT NOT NULL CHECK (valuation_status IN ('valued', 'missing_price', 'stale_price', 'unsupported_quote')),
  trade_value_usd TEXT,
  price_snapshot_id TEXT,
  admission TEXT NOT NULL CHECK (admission IN ('admitted', 'late', 'backfill')),
  admission_watermark_ms INTEGER,
  detector_applied INTEGER NOT NULL DEFAULT 0 CHECK (detector_applied IN (0, 1)),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('pending', 'eligible', 'ineligible', 'late')),
  eligibility_reason TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (namespace, event_id),
  FOREIGN KEY (price_snapshot_id, namespace) REFERENCES price_snapshots(id, namespace)
);
CREATE INDEX trade_events_token_time ON trade_events(namespace, chain, mint, event_time_ms);
CREATE INDEX trade_events_wallet_time ON trade_events(namespace, wallet, event_time_ms);
CREATE INDEX trade_events_signature ON trade_events(namespace, signature);
CREATE INDEX trade_events_pending ON trade_events(namespace, event_time_ms)
  WHERE detector_applied = 0 AND admission = 'admitted';
CREATE INDEX trade_events_normalized ON trade_events(namespace, normalized_at_ms);

CREATE TABLE tokens (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  creator TEXT,
  create_signature TEXT,
  created_event_time_ms INTEGER,
  first_seen_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, chain, mint)
);

CREATE TABLE packs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('collecting', 'frozen')),
  config_version TEXT NOT NULL,
  evidence_version INTEGER NOT NULL DEFAULT 1,
  core_version INTEGER NOT NULL DEFAULT 1,
  first_event_time_ms INTEGER NOT NULL,
  trigger_event_time_ms INTEGER NOT NULL,
  trigger_event_id TEXT NOT NULL,
  triggered_at_ms INTEGER NOT NULL,
  last_accepted_event_time_ms INTEGER NOT NULL,
  initial_wallet_count INTEGER NOT NULL CHECK (initial_wallet_count >= 3),
  total_wallet_count INTEGER NOT NULL CHECK (total_wallet_count >= initial_wallet_count),
  eligible_buy_usd TEXT NOT NULL,
  eligible_buy_usd_approx REAL NOT NULL,
  expansion_end_ms INTEGER NOT NULL,
  suppress_until_ms INTEGER NOT NULL,
  frozen_at_ms INTEGER,
  invalidated INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  invalidation_reason TEXT,
  patterns_json TEXT NOT NULL CHECK (json_valid(patterns_json)),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  UNIQUE (id, namespace),
  FOREIGN KEY (namespace, trigger_event_id) REFERENCES trade_events(namespace, event_id)
);
CREATE INDEX packs_recent ON packs(namespace, trigger_event_time_ms DESC, id DESC);
CREATE INDEX packs_mint ON packs(namespace, mint, trigger_event_time_ms DESC);
CREATE INDEX packs_collecting ON packs(namespace, state, expansion_end_ms);

CREATE TABLE pack_events (
  pack_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('initial', 'expansion')),
  accepted_at_event_time_ms INTEGER NOT NULL,
  accepted_at_expansion INTEGER NOT NULL DEFAULT 0 CHECK (accepted_at_expansion IN (0, 1)),
  evidence_version INTEGER NOT NULL,
  PRIMARY KEY (pack_id, event_id),
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace),
  FOREIGN KEY (namespace, event_id) REFERENCES trade_events(namespace, event_id)
);
CREATE INDEX pack_events_event ON pack_events(namespace, event_id);

CREATE TABLE pack_members (
  pack_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  wallet TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('initial', 'expanded')),
  first_entry_time_ms INTEGER NOT NULL,
  initial_first_entry_time_ms INTEGER,
  joined_at_event_time_ms INTEGER NOT NULL,
  eligible_buy_usd TEXT NOT NULL,
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  PRIMARY KEY (pack_id, wallet),
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace),
  CHECK ((member_kind = 'initial' AND initial_first_entry_time_ms IS NOT NULL) OR (member_kind = 'expanded' AND initial_first_entry_time_ms IS NULL))
);
CREATE INDEX pack_members_wallet ON pack_members(namespace, wallet);

CREATE TABLE detector_checkpoints (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  buffer_json TEXT NOT NULL CHECK (json_valid(buffer_json)),
  active_pack_id TEXT,
  first_event_time_ms INTEGER,
  last_accepted_time_ms INTEGER,
  suppress_until_ms INTEGER,
  config_version TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, chain, mint),
  FOREIGN KEY (active_pack_id, namespace) REFERENCES packs(id, namespace)
);

CREATE TABLE api_campaigns (
  id TEXT PRIMARY KEY,
  configured_budget INTEGER NOT NULL CHECK (configured_budget >= 0),
  started_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER,
  closed_at_ms INTEGER
);

CREATE TABLE nansen_sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES api_campaigns(id),
  started_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  smart_money_ends_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  ended_reason TEXT,
  started_by TEXT NOT NULL,
  CHECK (smart_money_ends_at_ms <= ends_at_ms)
);

CREATE TABLE api_usage (
  attempt_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES api_campaigns(id),
  job_id TEXT,
  lane TEXT NOT NULL CHECK (lane IN ('PRICE', 'BASE_ENRICHMENT', 'SMART_MONEY')),
  endpoint TEXT NOT NULL,
  parameter_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject_id TEXT,
  retry_of_attempt_id TEXT REFERENCES api_usage(attempt_id),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  http_outcome TEXT NOT NULL CHECK (http_outcome IN ('pending', 'success', 'http_error', 'network_error', 'timeout')),
  normalization_status TEXT NOT NULL CHECK (normalization_status IN ('pending', 'ok', 'schema_error', 'not_applicable')),
  provider_request_id TEXT,
  expected_credits INTEGER,
  quoted_credits INTEGER,
  actual_credits INTEGER,
  remaining_credits INTEGER,
  reservation_status TEXT NOT NULL CHECK (reservation_status IN ('reserved', 'settled', 'unresolved', 'released')),
  snapshot_id TEXT,
  error_code TEXT
);
CREATE INDEX api_usage_campaign ON api_usage(campaign_id, started_at_ms);

CREATE TABLE budget_reservations (
  attempt_id TEXT NOT NULL UNIQUE REFERENCES api_usage(attempt_id),
  campaign_id TEXT NOT NULL REFERENCES api_campaigns(id),
  lane TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  settled_amount INTEGER CHECK (settled_amount IS NULL OR settled_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'unresolved', 'released')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX budget_reservations_campaign ON budget_reservations(campaign_id, status);

CREATE TABLE enrichment_snapshots (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  endpoint TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('token', 'wallet', 'global')),
  subject_id TEXT NOT NULL,
  parameter_hash TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  scope_hash TEXT,
  fetched_at_ms INTEGER NOT NULL,
  period_start_ms INTEGER,
  period_end_ms INTEGER,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'empty', 'unavailable', 'error', 'budget_paused')),
  coverage TEXT NOT NULL CHECK (coverage IN ('unknown', 'partial', 'window_scanned')),
  reason_code TEXT,
  page INTEGER,
  is_last_page INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  attempt_id TEXT,
  schema_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('nansen', 'fixture', 'recorded')),
  UNIQUE (id, namespace)
);
CREATE INDEX enrichment_by_subject ON enrichment_snapshots(namespace, endpoint, subject_id, fetched_at_ms DESC);
CREATE INDEX enrichment_by_params ON enrichment_snapshots(namespace, endpoint, parameter_hash, fetched_at_ms DESC);
CREATE TRIGGER enrichment_snapshots_no_update BEFORE UPDATE ON enrichment_snapshots
BEGIN SELECT RAISE(ABORT, 'enrichment snapshots are immutable'); END;

CREATE TABLE pack_enrichment (
  pack_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_requested', 'scheduled')),
  requested_by TEXT,
  profile_wallets_json TEXT NOT NULL CHECK (json_valid(profile_wallets_json)),
  relationship_wallets_json TEXT NOT NULL CHECK (json_valid(relationship_wallets_json)),
  scheduled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace)
);
CREATE INDEX pack_enrichment_status ON pack_enrichment(namespace, status);

CREATE TABLE pack_assessments (
  pack_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL,
  analysis_state TEXT NOT NULL CHECK (analysis_state IN ('not_requested', 'queued', 'running', 'partial', 'complete', 'error', 'budget_paused')),
  review_flags_json TEXT NOT NULL CHECK (json_valid(review_flags_json)),
  scheduled_member_count INTEGER NOT NULL,
  total_member_count INTEGER NOT NULL,
  snapshot_ids_json TEXT NOT NULL CHECK (json_valid(snapshot_ids_json)),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pack_id, version),
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace)
);

CREATE TABLE smart_money_observations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  fingerprint TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  transaction_hash TEXT NOT NULL,
  trader_address TEXT NOT NULL,
  trader_label TEXT,
  token_bought_address TEXT NOT NULL,
  token_sold_address TEXT NOT NULL,
  token_bought_symbol TEXT,
  token_sold_symbol TEXT,
  token_bought_amount TEXT,
  token_sold_amount TEXT,
  block_time_ms INTEGER NOT NULL,
  trade_value_usd TEXT,
  ambiguous_swap_identity INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_swap_identity IN (0, 1)),
  first_seen_at_ms INTEGER NOT NULL,
  UNIQUE (namespace, fingerprint),
  UNIQUE (id, namespace)
);
CREATE INDEX sm_obs_bought ON smart_money_observations(namespace, token_bought_address, block_time_ms);
CREATE INDEX sm_obs_sold ON smart_money_observations(namespace, token_sold_address, block_time_ms);
CREATE INDEX sm_obs_trader ON smart_money_observations(namespace, trader_address);
CREATE INDEX sm_obs_hash ON smart_money_observations(namespace, transaction_hash);
CREATE INDEX sm_obs_time ON smart_money_observations(namespace, block_time_ms DESC);

CREATE TABLE smart_money_observation_sources (
  namespace TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  UNIQUE (namespace, observation_id, snapshot_id),
  FOREIGN KEY (observation_id, namespace) REFERENCES smart_money_observations(id, namespace),
  FOREIGN KEY (snapshot_id, namespace) REFERENCES enrichment_snapshots(id, namespace)
);

CREATE TABLE token_smart_money_metrics (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  as_of_ms INTEGER NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('5m', '1h', '24h')),
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  observed_unique_buyers INTEGER,
  count_qualifier TEXT NOT NULL CHECK (count_qualifier IN ('observed', 'at_least', 'unknown')),
  known_buy_usd TEXT,
  missing_valuation_count INTEGER NOT NULL,
  ambiguous_trade_count INTEGER NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  scope_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_snapshot_ids_json TEXT NOT NULL CHECK (json_valid(source_snapshot_ids_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (namespace, chain, mint, as_of_ms, window, scope_hash, revision)
);
CREATE INDEX token_sm_latest ON token_smart_money_metrics(namespace, mint, created_at_ms DESC);
CREATE TRIGGER token_sm_metrics_no_update BEFORE UPDATE ON token_smart_money_metrics
BEGIN SELECT RAISE(ABORT, 'token Smart Money metrics are immutable'); END;

CREATE TABLE pack_smart_money_contexts (
  pack_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  evidence_version INTEGER,
  confirmed_member_count INTEGER,
  checked_member_count INTEGER NOT NULL,
  total_member_count INTEGER NOT NULL,
  matched_observation_ids_json TEXT NOT NULL CHECK (json_valid(matched_observation_ids_json)),
  member_matches_json TEXT NOT NULL CHECK (json_valid(member_matches_json)),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pack_id, context_version),
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace)
);

CREATE TABLE pack_smart_money_evidence (
  namespace TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  match_level TEXT NOT NULL CHECK (match_level IN ('pack_buy_confirmed', 'wallet_seen', 'ambiguous')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (pack_id, observation_id, wallet),
  FOREIGN KEY (pack_id, namespace) REFERENCES packs(id, namespace),
  FOREIGN KEY (observation_id, namespace) REFERENCES smart_money_observations(id, namespace)
);

CREATE TABLE poller_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  scope TEXT NOT NULL,
  last_page INTEGER,
  oldest_block_time_ms INTEGER,
  newest_block_time_ms INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_run_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  campaign_id TEXT REFERENCES api_campaigns(id),
  lane TEXT NOT NULL CHECK (lane IN ('PRICE', 'BASE_ENRICHMENT', 'SMART_MONEY')),
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  pack_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'budget_paused')),
  status_reason TEXT,
  active_dedupe_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  next_attempt_at_ms INTEGER NOT NULL,
  enqueued_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  requested_by TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE INDEX jobs_dispatch ON jobs(status, lane, next_attempt_at_ms, enqueued_at_ms);
CREATE INDEX jobs_pack ON jobs(pack_id);

CREATE TABLE collector_gaps (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  reason TEXT NOT NULL,
  recovery_state TEXT NOT NULL CHECK (recovery_state IN ('open', 'closed_unrecovered', 'recovered'))
);
CREATE INDEX collector_gaps_ns ON collector_gaps(namespace, started_at_ms);

CREATE TABLE event_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('pack.created', 'pack.updated', 'analysis.updated', 'smart_money.updated', 'source.status', 'resync_required')),
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
);
CREATE INDEX outbox_namespace_sequence ON event_outbox(namespace, sequence);

CREATE TABLE replay_runs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  dataset_id TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  config_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('recorded-arrival', 'historical-event-time')),
  clock_json TEXT NOT NULL CHECK (json_valid(clock_json)),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  result_hash TEXT,
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json))
);

CREATE TABLE idempotency_keys (
  actor TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (actor, route, key)
);

CREATE TABLE demo_pins (
  namespace TEXT NOT NULL REFERENCES namespaces(id),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  mint TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, chain, mint)
);

CREATE TABLE audit_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  existing_hash TEXT NOT NULL,
  incoming_hash TEXT NOT NULL,
  detected_at_ms INTEGER NOT NULL
);

CREATE TABLE operational_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  component TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (name IN ('radar_viewed', 'pack_opened', 'wallet_opened', 'evidence_opened', 'smart_money_panel_viewed', 'data_state_visible')),
  mode TEXT NOT NULL,
  screen TEXT NOT NULL,
  pack_id TEXT,
  created_at_ms INTEGER NOT NULL
);
