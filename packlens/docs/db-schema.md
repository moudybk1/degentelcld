# PackLens database schema

Generated from `migrations/` (0001_init.sql, 0002_price_policy.sql) by `npm run db:schema-doc`. Do not edit by hand.

SQLite runs in WAL mode with foreign keys enabled on every connection. Namespaces (`live:`, `fixture:`, `replay:`) isolate data; composite foreign keys keep references inside one namespace.

## `analytics_events`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | INTEGER | yes | PK |  |
| `name` | TEXT | no |  |  |
| `mode` | TEXT | no |  |  |
| `screen` | TEXT | no |  |  |
| `pack_id` | TEXT | yes |  |  |
| `created_at_ms` | INTEGER | no |  |  |

## `api_campaigns`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `configured_budget` | INTEGER | no |  |  |
| `started_at_ms` | INTEGER | no |  |  |
| `ends_at_ms` | INTEGER | yes |  |  |
| `closed_at_ms` | INTEGER | yes |  |  |

## `api_usage`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `attempt_id` | TEXT | yes | PK |  |
| `campaign_id` | TEXT | no |  |  |
| `job_id` | TEXT | yes |  |  |
| `lane` | TEXT | no |  |  |
| `endpoint` | TEXT | no |  |  |
| `parameter_hash` | TEXT | no |  |  |
| `purpose` | TEXT | no |  |  |
| `subject_id` | TEXT | yes |  |  |
| `retry_of_attempt_id` | TEXT | yes |  |  |
| `started_at_ms` | INTEGER | no |  |  |
| `finished_at_ms` | INTEGER | yes |  |  |
| `duration_ms` | INTEGER | yes |  |  |
| `http_status` | INTEGER | yes |  |  |
| `http_outcome` | TEXT | no |  |  |
| `normalization_status` | TEXT | no |  |  |
| `provider_request_id` | TEXT | yes |  |  |
| `expected_credits` | INTEGER | yes |  |  |
| `quoted_credits` | INTEGER | yes |  |  |
| `actual_credits` | INTEGER | yes |  |  |
| `remaining_credits` | INTEGER | yes |  |  |
| `reservation_status` | TEXT | no |  |  |
| `snapshot_id` | TEXT | yes |  |  |
| `error_code` | TEXT | yes |  |  |

Foreign keys: (retry_of_attempt_id) → `api_usage`(attempt_id); (campaign_id) → `api_campaigns`(id)

Indexes: `api_usage_campaign`

## `audit_conflicts`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | INTEGER | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `event_id` | TEXT | no |  |  |
| `existing_hash` | TEXT | no |  |  |
| `incoming_hash` | TEXT | no |  |  |
| `detected_at_ms` | INTEGER | no |  |  |

## `budget_reservations`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `attempt_id` | TEXT | no |  |  |
| `campaign_id` | TEXT | no |  |  |
| `lane` | TEXT | no |  |  |
| `amount` | INTEGER | no |  |  |
| `settled_amount` | INTEGER | yes |  |  |
| `status` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |
| `updated_at_ms` | INTEGER | no |  |  |

Foreign keys: (campaign_id) → `api_campaigns`(id); (attempt_id) → `api_usage`(attempt_id)

Indexes: `budget_reservations_campaign`

## `collector_gaps`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `started_at_ms` | INTEGER | no |  |  |
| `ended_at_ms` | INTEGER | yes |  |  |
| `reason` | TEXT | no |  |  |
| `recovery_state` | TEXT | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `collector_gaps_ns`

## `demo_pins`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no | PK |  |
| `chain` | TEXT | no | PK |  |
| `mint` | TEXT | no | PK |  |
| `enabled` | INTEGER | no |  |  |
| `updated_at_ms` | INTEGER | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

## `detector_checkpoints`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no | PK |  |
| `chain` | TEXT | no | PK |  |
| `mint` | TEXT | no | PK |  |
| `buffer_json` | TEXT | no |  |  |
| `active_pack_id` | TEXT | yes |  |  |
| `first_event_time_ms` | INTEGER | yes |  |  |
| `last_accepted_time_ms` | INTEGER | yes |  |  |
| `suppress_until_ms` | INTEGER | yes |  |  |
| `config_version` | TEXT | no |  |  |
| `updated_at_ms` | INTEGER | no |  |  |

Foreign keys: (active_pack_id, namespace) → `packs`(id, namespace); (namespace) → `namespaces`(id)

## `enrichment_snapshots`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `endpoint` | TEXT | no |  |  |
| `subject_type` | TEXT | no |  |  |
| `subject_id` | TEXT | no |  |  |
| `parameter_hash` | TEXT | no |  |  |
| `params_json` | TEXT | no |  |  |
| `scope_hash` | TEXT | yes |  |  |
| `fetched_at_ms` | INTEGER | no |  |  |
| `period_start_ms` | INTEGER | yes |  |  |
| `period_end_ms` | INTEGER | yes |  |  |
| `availability` | TEXT | no |  |  |
| `coverage` | TEXT | no |  |  |
| `reason_code` | TEXT | yes |  |  |
| `page` | INTEGER | yes |  |  |
| `is_last_page` | INTEGER | yes |  |  |
| `result_json` | TEXT | yes |  |  |
| `attempt_id` | TEXT | yes |  |  |
| `schema_version` | TEXT | no |  |  |
| `source` | TEXT | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `enrichment_by_params`, `enrichment_by_subject`

## `event_outbox`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `sequence` | INTEGER | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `event_type` | TEXT | no |  |  |
| `aggregate_id` | TEXT | no |  |  |
| `aggregate_version` | INTEGER | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |
| `payload_json` | TEXT | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `outbox_namespace_sequence`

## `idempotency_keys`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `actor` | TEXT | no | PK |  |
| `route` | TEXT | no | PK |  |
| `key` | TEXT | no | PK |  |
| `body_hash` | TEXT | no |  |  |
| `response_json` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |

## `jobs`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `campaign_id` | TEXT | yes |  |  |
| `lane` | TEXT | no |  |  |
| `type` | TEXT | no |  |  |
| `subject` | TEXT | no |  |  |
| `pack_id` | TEXT | yes |  |  |
| `payload_json` | TEXT | no |  |  |
| `status` | TEXT | no |  |  |
| `status_reason` | TEXT | yes |  |  |
| `active_dedupe_key` | TEXT | yes |  |  |
| `attempts` | INTEGER | no |  | 0 |
| `lease_until_ms` | INTEGER | yes |  |  |
| `next_attempt_at_ms` | INTEGER | no |  |  |
| `enqueued_at_ms` | INTEGER | no |  |  |
| `started_at_ms` | INTEGER | yes |  |  |
| `finished_at_ms` | INTEGER | yes |  |  |
| `requested_by` | TEXT | no |  |  |
| `result_json` | TEXT | yes |  |  |

Foreign keys: (campaign_id) → `api_campaigns`(id); (namespace) → `namespaces`(id)

Indexes: `jobs_pack`, `jobs_dispatch`

## `meta`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `key` | TEXT | yes | PK |  |
| `value` | TEXT | no |  |  |

## `namespaces`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `mode` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |
| `dataset_hash` | TEXT | yes |  |  |
| `label` | TEXT | yes |  |  |
| `state` | TEXT | no |  | 'active' |
| `first_observed_event_ms` | INTEGER | yes |  |  |
| `watermark_ms` | INTEGER | yes |  |  |

## `nansen_sessions`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `campaign_id` | TEXT | no |  |  |
| `started_at_ms` | INTEGER | no |  |  |
| `ends_at_ms` | INTEGER | no |  |  |
| `smart_money_ends_at_ms` | INTEGER | no |  |  |
| `ended_at_ms` | INTEGER | yes |  |  |
| `ended_reason` | TEXT | yes |  |  |
| `started_by` | TEXT | no |  |  |

Foreign keys: (campaign_id) → `api_campaigns`(id)

## `operational_errors`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | INTEGER | yes | PK |  |
| `at_ms` | INTEGER | no |  |  |
| `component` | TEXT | no |  |  |
| `code` | TEXT | no |  |  |
| `message` | TEXT | no |  |  |

## `pack_assessments`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `pack_id` | TEXT | no | PK |  |
| `namespace` | TEXT | no |  |  |
| `version` | INTEGER | no | PK |  |
| `analysis_state` | TEXT | no |  |  |
| `review_flags_json` | TEXT | no |  |  |
| `scheduled_member_count` | INTEGER | no |  |  |
| `total_member_count` | INTEGER | no |  |  |
| `snapshot_ids_json` | TEXT | no |  |  |
| `reasons_json` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |

Foreign keys: (pack_id, namespace) → `packs`(id, namespace)

## `pack_enrichment`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `pack_id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `status` | TEXT | no |  |  |
| `requested_by` | TEXT | yes |  |  |
| `profile_wallets_json` | TEXT | no |  |  |
| `relationship_wallets_json` | TEXT | no |  |  |
| `scheduled_at_ms` | INTEGER | yes |  |  |
| `created_at_ms` | INTEGER | no |  |  |

Foreign keys: (pack_id, namespace) → `packs`(id, namespace)

Indexes: `pack_enrichment_status`

## `pack_events`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `pack_id` | TEXT | no | PK |  |
| `namespace` | TEXT | no |  |  |
| `event_id` | TEXT | no | PK |  |
| `evidence_role` | TEXT | no |  |  |
| `accepted_at_event_time_ms` | INTEGER | no |  |  |
| `accepted_at_expansion` | INTEGER | no |  | 0 |
| `evidence_version` | INTEGER | no |  |  |

Foreign keys: (namespace, event_id) → `trade_events`(namespace, event_id); (pack_id, namespace) → `packs`(id, namespace)

Indexes: `pack_events_event`

## `pack_members`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `pack_id` | TEXT | no | PK |  |
| `namespace` | TEXT | no |  |  |
| `wallet` | TEXT | no | PK |  |
| `member_kind` | TEXT | no |  |  |
| `first_entry_time_ms` | INTEGER | no |  |  |
| `initial_first_entry_time_ms` | INTEGER | yes |  |  |
| `joined_at_event_time_ms` | INTEGER | no |  |  |
| `eligible_buy_usd` | TEXT | no |  |  |
| `event_ids_json` | TEXT | no |  |  |
| `summary_json` | TEXT | no |  |  |

Foreign keys: (pack_id, namespace) → `packs`(id, namespace)

Indexes: `pack_members_wallet`

## `pack_smart_money_contexts`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `pack_id` | TEXT | no | PK |  |
| `namespace` | TEXT | no |  |  |
| `context_version` | INTEGER | no | PK |  |
| `evidence_version` | INTEGER | yes |  |  |
| `confirmed_member_count` | INTEGER | yes |  |  |
| `checked_member_count` | INTEGER | no |  |  |
| `total_member_count` | INTEGER | no |  |  |
| `matched_observation_ids_json` | TEXT | no |  |  |
| `member_matches_json` | TEXT | no |  |  |
| `state_json` | TEXT | no |  |  |
| `updated_at_ms` | INTEGER | no |  |  |

Foreign keys: (pack_id, namespace) → `packs`(id, namespace)

## `pack_smart_money_evidence`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no |  |  |
| `pack_id` | TEXT | no |  |  |
| `observation_id` | TEXT | no |  |  |
| `wallet` | TEXT | no |  |  |
| `match_level` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |

Foreign keys: (observation_id, namespace) → `smart_money_observations`(id, namespace); (pack_id, namespace) → `packs`(id, namespace)

## `packs`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `chain` | TEXT | no |  |  |
| `mint` | TEXT | no |  |  |
| `state` | TEXT | no |  |  |
| `config_version` | TEXT | no |  |  |
| `evidence_version` | INTEGER | no |  | 1 |
| `core_version` | INTEGER | no |  | 1 |
| `first_event_time_ms` | INTEGER | no |  |  |
| `trigger_event_time_ms` | INTEGER | no |  |  |
| `trigger_event_id` | TEXT | no |  |  |
| `triggered_at_ms` | INTEGER | no |  |  |
| `last_accepted_event_time_ms` | INTEGER | no |  |  |
| `initial_wallet_count` | INTEGER | no |  |  |
| `total_wallet_count` | INTEGER | no |  |  |
| `eligible_buy_usd` | TEXT | no |  |  |
| `eligible_buy_usd_approx` | REAL | no |  |  |
| `expansion_end_ms` | INTEGER | no |  |  |
| `suppress_until_ms` | INTEGER | no |  |  |
| `frozen_at_ms` | INTEGER | yes |  |  |
| `invalidated` | INTEGER | no |  | 0 |
| `invalidation_reason` | TEXT | yes |  |  |
| `patterns_json` | TEXT | no |  |  |
| `summary_json` | TEXT | no |  |  |

Foreign keys: (namespace, trigger_event_id) → `trade_events`(namespace, event_id); (namespace) → `namespaces`(id)

Indexes: `packs_collecting`, `packs_mint`, `packs_recent`

## `poller_checkpoints`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `session_id` | TEXT | yes |  |  |
| `scope` | TEXT | no |  |  |
| `last_page` | INTEGER | yes |  |  |
| `oldest_block_time_ms` | INTEGER | yes |  |  |
| `newest_block_time_ms` | INTEGER | yes |  |  |
| `request_count` | INTEGER | no |  | 0 |
| `last_run_at_ms` | INTEGER | yes |  |  |
| `updated_at_ms` | INTEGER | no |  |  |

## `price_snapshots`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `chain` | TEXT | no |  |  |
| `quote_mint` | TEXT | no |  |  |
| `requested_from_ms` | INTEGER | no |  |  |
| `requested_to_ms` | INTEGER | no |  |  |
| `request_started_at_ms` | INTEGER | no |  |  |
| `response_received_at_ms` | INTEGER | no |  |  |
| `available_at_ms` | INTEGER | no |  |  |
| `candles_json` | TEXT | no |  |  |
| `provider_request_id` | TEXT | yes |  |  |
| `attempt_id` | TEXT | yes |  |  |
| `source` | TEXT | no |  |  |
| `timeframe` | TEXT | no |  | '1m' |
| `policy_version` | TEXT | no |  | 'nansen-1m-closed-v1' |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `price_snapshots_lookup`

## `replay_runs`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `dataset_id` | TEXT | no |  |  |
| `dataset_hash` | TEXT | no |  |  |
| `config_version` | TEXT | no |  |  |
| `mode` | TEXT | no |  |  |
| `clock_json` | TEXT | no |  |  |
| `started_at_ms` | INTEGER | no |  |  |
| `finished_at_ms` | INTEGER | yes |  |  |
| `result_hash` | TEXT | yes |  |  |
| `report_json` | TEXT | yes |  |  |

Foreign keys: (namespace) → `namespaces`(id)

## `schema_migrations`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `version` | TEXT | yes | PK |  |
| `name` | TEXT | no |  |  |
| `checksum` | TEXT | no |  |  |
| `applied_at_ms` | INTEGER | no |  |  |

## `smart_money_observation_sources`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no |  |  |
| `observation_id` | TEXT | no |  |  |
| `snapshot_id` | TEXT | no |  |  |
| `scope_hash` | TEXT | no |  |  |

Foreign keys: (snapshot_id, namespace) → `enrichment_snapshots`(id, namespace); (observation_id, namespace) → `smart_money_observations`(id, namespace)

## `smart_money_observations`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `fingerprint` | TEXT | no |  |  |
| `chain` | TEXT | no |  |  |
| `transaction_hash` | TEXT | no |  |  |
| `trader_address` | TEXT | no |  |  |
| `trader_label` | TEXT | yes |  |  |
| `token_bought_address` | TEXT | no |  |  |
| `token_sold_address` | TEXT | no |  |  |
| `token_bought_symbol` | TEXT | yes |  |  |
| `token_sold_symbol` | TEXT | yes |  |  |
| `token_bought_amount` | TEXT | yes |  |  |
| `token_sold_amount` | TEXT | yes |  |  |
| `block_time_ms` | INTEGER | no |  |  |
| `trade_value_usd` | TEXT | yes |  |  |
| `ambiguous_swap_identity` | INTEGER | no |  | 0 |
| `first_seen_at_ms` | INTEGER | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `sm_obs_time`, `sm_obs_hash`, `sm_obs_trader`, `sm_obs_sold`, `sm_obs_bought`

## `token_smart_money_metrics`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `id` | TEXT | yes | PK |  |
| `namespace` | TEXT | no |  |  |
| `chain` | TEXT | no |  |  |
| `mint` | TEXT | no |  |  |
| `as_of_ms` | INTEGER | no |  |  |
| `window` | TEXT | no |  |  |
| `window_start_ms` | INTEGER | no |  |  |
| `window_end_ms` | INTEGER | no |  |  |
| `observed_unique_buyers` | INTEGER | yes |  |  |
| `count_qualifier` | TEXT | no |  |  |
| `known_buy_usd` | TEXT | yes |  |  |
| `missing_valuation_count` | INTEGER | no |  |  |
| `ambiguous_trade_count` | INTEGER | no |  |  |
| `state_json` | TEXT | no |  |  |
| `scope_hash` | TEXT | no |  |  |
| `revision` | INTEGER | no |  |  |
| `source_snapshot_ids_json` | TEXT | no |  |  |
| `created_at_ms` | INTEGER | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

Indexes: `token_sm_latest`

## `tokens`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no | PK |  |
| `chain` | TEXT | no | PK |  |
| `mint` | TEXT | no | PK |  |
| `name` | TEXT | yes |  |  |
| `symbol` | TEXT | yes |  |  |
| `uri` | TEXT | yes |  |  |
| `creator` | TEXT | yes |  |  |
| `create_signature` | TEXT | yes |  |  |
| `created_event_time_ms` | INTEGER | yes |  |  |
| `first_seen_at_ms` | INTEGER | no |  |  |

Foreign keys: (namespace) → `namespaces`(id)

## `trade_events`

| Column | Type | Null | Key | Default |
|---|---|---|---|---|
| `namespace` | TEXT | no | PK |  |
| `event_id` | TEXT | no | PK |  |
| `chain` | TEXT | no |  |  |
| `mint` | TEXT | no |  |  |
| `wallet` | TEXT | no |  |  |
| `signature` | TEXT | no |  |  |
| `event_ordinal` | INTEGER | no |  |  |
| `slot` | INTEGER | no |  |  |
| `event_time_ms` | INTEGER | no |  |  |
| `received_at_ms` | INTEGER | no |  |  |
| `normalized_at_ms` | INTEGER | no |  |  |
| `side` | TEXT | no |  |  |
| `source_mode` | TEXT | no |  |  |
| `valuation_status` | TEXT | no |  |  |
| `trade_value_usd` | TEXT | yes |  |  |
| `price_snapshot_id` | TEXT | yes |  |  |
| `admission` | TEXT | no |  |  |
| `admission_watermark_ms` | INTEGER | yes |  |  |
| `detector_applied` | INTEGER | no |  | 0 |
| `eligibility` | TEXT | no |  |  |
| `eligibility_reason` | TEXT | yes |  |  |
| `payload_json` | TEXT | no |  |  |
| `payload_hash` | TEXT | no |  |  |

Foreign keys: (price_snapshot_id, namespace) → `price_snapshots`(id, namespace); (namespace) → `namespaces`(id)

Indexes: `trade_events_normalized`, `trade_events_pending`, `trade_events_signature`, `trade_events_wallet_time`, `trade_events_token_time`

## Immutability triggers

- `enrichment_snapshots_no_update` on `enrichment_snapshots`: updates are rejected; new responses create new rows.
- `price_snapshots_no_update` on `price_snapshots`: updates are rejected; new responses create new rows.
- `token_sm_metrics_no_update` on `token_smart_money_metrics`: updates are rejected; new responses create new rows.
