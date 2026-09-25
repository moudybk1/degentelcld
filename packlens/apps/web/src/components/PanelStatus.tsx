import type { PanelState } from "@packlens/contracts";
import { dateTimeUtc, relative } from "../lib/format";
import { Tag } from "./ui";

/** English labels for data states (PRD §10). State is never conveyed by color alone. */
export function availabilityLabel(state: PanelState, hasData: boolean): string {
  switch (state.availability) {
    case "not_requested":
      return state.reasonCode === "session_ended" ? "Not analyzed; the session ended first" : "Not analyzed yet";
    case "queued":
      return "Queued for analysis";
    case "available":
      return state.reasonCode === "update_delayed" ? "Update delayed; showing the last checked data" : "Available";
    case "empty":
      return state.reasonCode === "update_delayed" ? "Update delayed; showing the last checked data" : "Observed empty in the checked data";
    case "unavailable":
      return "Data is unavailable from this source";
    case "error":
      return hasData ? "Update delayed" : "Could not load from the provider; update delayed";
    case "budget_paused":
      return "Analysis paused";
  }
}

export function PanelStatus({ state, source, compact }: { state: PanelState; source?: string; compact?: boolean }) {
  const hasData = state.availability === "available" || state.availability === "empty";
  const tone =
    state.availability === "error" ? "red" : state.availability === "budget_paused" ? "yellow" : state.availability === "unavailable" ? "gray" : hasData ? "green" : "outline";
  return (
    <div className="panel-state">
      <Tag tone={tone}>{hasData ? (state.availability === "empty" ? "Empty" : "Available") : availabilityLabel(state, false).split(";")[0]}</Tag>
      {state.coverage === "partial" && <Tag tone="yellow" title="Some pages, periods, or valuations are missing">Partial</Tag>}
      {state.coverage === "window_scanned" && !compact && <Tag tone="outline" title="The provider response for this window was examined without known gaps; not a census of all on-chain activity">Window scanned</Tag>}
      {state.freshness === "stale" && <Tag tone="outline" title="Older than the refresh interval">Stale</Tag>}
      {!compact && (
        <span>
          {hasData && state.reasonCode === "update_delayed"
            ? "Update delayed. "
            : !hasData
              ? `${availabilityLabel(state, false)}. `
              : ""}
          {state.fetchedAt ? (
            <span title={dateTimeUtc(state.fetchedAt)}>
              {state.freshness === "stale" ? "Last checked" : "Fetched"} {dateTimeUtc(state.fetchedAt)} ({relative(state.fetchedAt)})
            </span>
          ) : null}
          {source ? <span> · {source}</span> : null}
        </span>
      )}
    </div>
  );
}
