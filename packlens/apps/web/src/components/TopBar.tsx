import { NavLink } from "react-router";
import type { SourceStatus } from "@packlens/contracts";
import { useEvents } from "../api/events";
import { useNow } from "../api/hooks";
import { relative } from "../lib/format";
import { useNsHref } from "../state/namespace";
import { Search } from "./Search";
import { Tag } from "./ui";
import symbolUrl from "../assets/brand/symbol-red-160.png";
import { BASELINE_RULE, ruleUsd } from "../lib/rule";

type FeedBadge = { text: string; tone: "green" | "yellow" | "red" | "blue" | "gray"; live: boolean; title: string };

/**
 * The one source indicator in the top bar: "Live feed" while new packs can be
 * detected. A connected stream is not enough: without a fresh quote price no
 * buy can pass the USD check, so the badge then says detection is paused
 * instead of showing a green light. The time of the last event is in the tooltip.
 */
function feedBadge(status: SourceStatus | null, pulseHealth: string | undefined, lastMessageAt: string | null, priceState: string | undefined, now: number): FeedBadge {
  const health = pulseHealth ?? status?.collector.health;
  if (!status) return { text: "Checking…", tone: "gray", live: false, title: "Checking the data source." };
  if (health === "fixture") return { text: "Example data", tone: "blue", live: false, title: "Synthetic fixture data for offline use; not market observations." };
  if (health === "replay") return { text: "Replay", tone: "yellow", live: false, title: "A recorded dataset replayed with its original times." };
  if (health === "not_configured") return { text: "No source", tone: "red", live: false, title: "No pump.fun stream is configured, so no packs can be detected." };
  if (health === "connecting") return { text: "Connecting…", tone: "yellow", live: false, title: "Connecting to the pump.fun stream." };
  if (health === "disconnected") return { text: "Feed disconnected", tone: "red", live: false, title: "The pump.fun stream is disconnected; new packs cannot be detected until it reconnects." };
  if (priceState === "stale" || priceState === "waiting_for_price") {
    const check = `${ruleUsd(status.detector ?? BASELINE_RULE)} check`;
    return {
      text: "Detection paused",
      tone: "yellow",
      live: false,
      title: status.analysisPaused.paused
        ? `${status.analysisPaused.reason} Without a fresh SOL price, new buys cannot pass the ${check}, so no new packs form.`
        : `Without a fresh SOL price, new buys cannot pass the ${check}, so no new packs form.`,
    };
  }
  const age = lastMessageAt ? relative(lastMessageAt, now) : "no events yet";
  return {
    text: "Live feed",
    tone: "green",
    live: true,
    title: `Detecting packs · last event ${age}. The pump.fun trade feed is live; Nansen panels and prices show their own check times.`,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A ticking UTC clock: every time in the app is UTC, so the reference is always in view. */
function UtcClock() {
  const now = useNow(1000);
  const d = new Date(now);
  return (
    <span className="utc-clock" aria-hidden="true">
      <b>
        {pad(d.getUTCHours())}:{pad(d.getUTCMinutes())}:{pad(d.getUTCSeconds())}
      </b>
      &nbsp;UTC
    </span>
  );
}

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Pack Radar", end: true },
  { to: "/wallets", label: "Wallets" },
  { to: "/smart-money", label: "Smart Money" },
  { to: "/guide", label: "Guide" },
];

export function TopBar({ status }: { status: SourceStatus | null }) {
  const href = useNsHref();
  const { pulse } = useEvents();
  const now = useNow(3000);
  const priceState = pulse?.price ?? status?.price.state;
  const feed = feedBadge(status, pulse?.health, pulse?.lastMessageAt ?? status?.collector.lastMessageAt ?? null, priceState, now);
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
          {NAV.map((n, i) => (
            <NavLink key={n.to} to={href(n.to)} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
              <span className="nav-idx" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Search />
        <div className="topbar-right">
          <span className="feed-status" role="status" aria-live="polite">
            <Tag tone={feed.tone} className={feed.live ? "live" : undefined} dot pulse={feed.live} title={feed.title}>
              {feed.text}
            </Tag>
          </span>
          <UtcClock />
        </div>
      </div>
    </header>
  );
}
