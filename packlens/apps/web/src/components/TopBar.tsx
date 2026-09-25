import { NavLink } from "react-router";
import type { SourceStatus } from "@packlens/contracts";
import { useEvents } from "../api/events";
import { useNow } from "../api/hooks";
import { relative } from "../lib/format";
import { useNsHref } from "../state/namespace";
import { ModeBadge } from "./ui";

function healthView(status: SourceStatus | null, pulseHealth: string | undefined, lastMessageAt: string | null, now: number): { dot: string; text: string } {
  const health = pulseHealth ?? status?.collector.health;
  if (!status) return { dot: "", text: "Checking source…" };
  if (health === "fixture") return { dot: "ok", text: "Synthetic fixture data" };
  if (health === "replay") return { dot: "ok", text: "Replaying a recorded dataset" };
  if (health === "not_configured") return { dot: "bad", text: "Source not configured" };
  if (health === "connecting") return { dot: "warn", text: "Connecting to source…" };
  if (health === "disconnected") return { dot: "bad", text: "Source disconnected" };
  const age = lastMessageAt ? relative(lastMessageAt, now) : "no events yet";
  return { dot: "ok", text: `Connected · last event ${age}` };
}

export function TopBar({ status }: { status: SourceStatus | null }) {
  const href = useNsHref();
  const { pulse } = useEvents();
  const now = useNow(3000);
  const health = healthView(status, pulse?.health, pulse?.lastMessageAt ?? status?.collector.lastMessageAt ?? null, now);
  const priceState = pulse?.price ?? status?.price.state;
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <NavLink to={href("/")} className="brand" aria-label="PackLens home">
          <span className="brand-mark" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="4" cy="5" r="1.8" fill="#F7F6F3" /><circle cx="10" cy="5" r="1.8" fill="#F7F6F3" /><circle cx="7" cy="10" r="1.8" fill="#F7F6F3" /></svg>
          </span>
          <span className="brand-name">PackLens</span>
          <span className="brand-sub">Solana · pump.fun</span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to={href("/")} end className={({ isActive }) => (isActive ? "active" : "")}>
            Pack Radar
          </NavLink>
          <NavLink to={href("/smart-money")} className={({ isActive }) => (isActive ? "active" : "")}>
            Smart Money Activity
          </NavLink>
          <NavLink to={href("/guide")} className={({ isActive }) => (isActive ? "active" : "")}>
            Guide
          </NavLink>
          <NavLink to={href("/operator")} className={({ isActive }) => (isActive ? "active" : "")}>
            Operator
          </NavLink>
        </nav>
        <div className="topbar-right">
          <span className="status" role="status" aria-live="polite">
            <span className={`dot ${health.dot}`} aria-hidden="true" />
            <span className="status-text">{health.text}</span>
            {priceState && priceState !== "not_applicable" && (
              <span className="status-text muted" title={status && !status.price.isBaseline ? `Quote price policy ${status.price.policyVersion}` : undefined}>
                · Price {priceState === "valid" ? "valid" : priceState === "stale" ? "stale" : "waiting"}
                {status && !status.price.isBaseline ? ` (${status.price.timeframe} fallback)` : ""}
              </span>
            )}
          </span>
          <ModeBadge mode={status?.mode} />
        </div>
      </div>
    </header>
  );
}
