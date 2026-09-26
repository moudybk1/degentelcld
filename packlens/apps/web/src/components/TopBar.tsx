import { NavLink } from "react-router";
import type { SourceStatus } from "@packlens/contracts";
import { useEvents } from "../api/events";
import { useNow } from "../api/hooks";
import { relative } from "../lib/format";
import { useNsHref } from "../state/namespace";
import { Search } from "./Search";
import { ModeBadge } from "./ui";
import symbolUrl from "../assets/brand/symbol-red-160.png";

/**
 * Whether new packs can be detected right now, in words. A connected stream
 * is not enough: without a fresh quote price no buy can pass the $20 check,
 * so the status says detection is paused instead of showing a green light.
 */
function healthView(status: SourceStatus | null, pulseHealth: string | undefined, lastMessageAt: string | null, priceState: string | undefined, now: number): { dot: string; text: string; title: string } {
  const health = pulseHealth ?? status?.collector.health;
  if (!status) return { dot: "", text: "Checking source…", title: "" };
  if (health === "fixture") return { dot: "ok", text: "Example data", title: "Synthetic fixture data for offline use; not market observations." };
  if (health === "replay") return { dot: "ok", text: "Replaying recorded data", title: "A recorded dataset replayed with its original times." };
  if (health === "not_configured") return { dot: "bad", text: "Source not configured", title: "No pump.fun stream is configured, so no packs can be detected." };
  if (health === "connecting") return { dot: "warn", text: "Connecting to source…", title: "" };
  if (health === "disconnected") return { dot: "bad", text: "Source disconnected", title: "The pump.fun stream is disconnected; new packs cannot be detected until it reconnects." };
  if (priceState === "stale" || priceState === "waiting_for_price") {
    return {
      dot: "warn",
      text: "Detection paused",
      title: status.analysisPaused.paused
        ? `${status.analysisPaused.reason} Without a fresh Nansen price, new buys cannot pass the $20 check, so no new packs form.`
        : "Without a fresh Nansen price, new buys cannot pass the $20 check, so no new packs form.",
    };
  }
  const age = lastMessageAt ? relative(lastMessageAt, now) : "no events yet";
  return { dot: "ok", text: `Detecting · last event ${age}`, title: "Connected to the pump.fun stream with a valid quote price." };
}

export function TopBar({ status }: { status: SourceStatus | null }) {
  const href = useNsHref();
  const { pulse } = useEvents();
  const now = useNow(3000);
  const priceState = pulse?.price ?? status?.price.state;
  const health = healthView(status, pulse?.health, pulse?.lastMessageAt ?? status?.collector.lastMessageAt ?? null, priceState, now);
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <NavLink to={href("/")} className="brand" aria-label="Degentellegence home">
          <img className="brand-mark" src={symbolUrl} width={32} height={32} alt="" />
          <span className="brand-text">
            <span className="brand-name">Degentellegence</span>
            <span className="brand-sub">Solana wallet intelligence</span>
          </span>
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to={href("/")} end className={({ isActive }) => (isActive ? "active" : "")}>
            Pack Radar
          </NavLink>
          <NavLink to={href("/smart-money")} className={({ isActive }) => (isActive ? "active" : "")}>
            Smart Money
          </NavLink>
          <NavLink to={href("/guide")} className={({ isActive }) => (isActive ? "active" : "")}>
            Guide
          </NavLink>
        </nav>
        <Search />
        <div className="topbar-right">
          <span className="status" role="status" aria-live="polite" title={health.title}>
            <span className={`dot ${health.dot}`} aria-hidden="true" />
            <span className="status-text">{health.text}</span>
          </span>
          <ModeBadge mode={status?.mode} />
        </div>
      </div>
    </header>
  );
}
