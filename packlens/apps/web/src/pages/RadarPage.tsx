import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowsClockwise, MagnifyingGlass, Question, Rows, SquaresFour, X } from "@phosphor-icons/react";
import type { AfterPackSummary, OverviewData, PackDetail, PackListData, PackListItem, SourceStatus } from "@packlens/contracts";
import { apiGet, ApiError, track } from "../api/client";
import { useEventListener } from "../api/events";
import { useMediaQuery, useNow } from "../api/hooks";
import { ActivityChart } from "../components/ActivityChart";
import { Highlights } from "../components/Highlights";
import { HowItWorks } from "../components/HowItWorks";
import { InfoTip } from "../components/InfoTip";
import { Decode, Reticle } from "../components/motion";
import { PackCard } from "../components/PackCard";
import { PackTable } from "../components/PackTable";
import { SizeBands } from "../components/SizeBands";
import { Empty, ErrorNote, LoadingBlock, Note, Skeleton, Stat, Tag } from "../components/ui";
import { clockUtc, int, relative, seconds, span, timeUtc, usdCompact } from "../lib/format";
import type { GlossaryKey } from "../lib/glossary";
import { useNamespace } from "../state/namespace";
import { ruleUsd, useRule } from "../lib/rule";

type RangeKey = "1h" | "6h" | "24h" | "7d" | "all";
type Range = { kind: "preset"; key: RangeKey } | { kind: "custom"; fromMs: number; toMs: number };
type Filters = { minWallets: string; minUsd: string; mint: string; range: Range; confirmedOnly: boolean; includeInvalidated: boolean };
type Params = Record<string, string | undefined>;

const DEFAULT_FILTERS: Filters = { minWallets: "3", minUsd: "", mint: "", range: { kind: "preset", key: "all" }, confirmedOnly: false, includeInvalidated: false };
const RANGES: { key: RangeKey; label: string; ms: number | null; name: string }[] = [
  { key: "1h", label: "1 h", ms: 3_600_000, name: "Last hour" },
  { key: "6h", label: "6 h", ms: 21_600_000, name: "Last 6 hours" },
  { key: "24h", label: "24 h", ms: 86_400_000, name: "Last 24 hours" },
  { key: "7d", label: "7 d", ms: 604_800_000, name: "Last 7 days" },
  { key: "all", label: "All", ms: null, name: "All time" },
];
const PAGE = 30;
const VIEW_KEY = "packlens.radar.view";

/** Ranges end now for live data; fixture and replay data are historical, so they end at the latest pack. */
function anchorFor(status: SourceStatus | null): number {
  return status && status.mode !== "live" && status.latestPackTriggerMs ? status.latestPackTriggerMs : Date.now();
}

function filterParams(f: Filters, anchorMs: number): Params {
  const r = f.range;
  const preset = r.kind === "preset" ? RANGES.find((x) => x.key === r.key) : undefined;
  return {
    minWallets: f.minWallets,
    minUsd: f.minUsd.trim() === "" ? undefined : f.minUsd.trim(),
    mint: f.mint.trim() === "" ? undefined : f.mint.trim(),
    from: r.kind === "custom" ? new Date(r.fromMs).toISOString() : preset?.ms ? new Date(anchorMs - preset.ms).toISOString() : undefined,
    to: r.kind === "custom" ? new Date(r.toMs - 1).toISOString() : undefined,
    confirmedSmartMoneyOnly: f.confirmedOnly ? "true" : undefined,
    includeInvalidated: f.includeInvalidated ? "true" : undefined,
  };
}

/** Derive a row from a detail snapshot, so enrichment updates a row in place without reordering. */
function itemFromDetail(d: PackDetail): PackListItem {
  return {
    core: d.core,
    token: d.token,
    patterns: d.patterns,
    analysisState: d.assessment.analysisState,
    smartMoney1h: d.smartMoney.windows[1]!,
    confirmedMemberCount: d.smartMoney.packConfirmation.confirmedMemberCount,
    totalMemberCount: d.core.totalWalletCount,
    invalidated: d.coverage.auditedInvalidated,
    after: d.after
      ? {
          lastChangePct: d.after.lastChangePct,
          peakChangePct: d.after.peak?.changePct ?? null,
          lastTradeAt: d.after.lastTradeAt,
          tradesAfter: d.after.activity.buys + d.after.activity.sells,
          membersSold: d.after.members.sold,
          memberCount: d.after.members.count,
          graduatedAt: d.after.graduatedAt,
        }
      : (undefined as unknown as AfterPackSummary),
  };
}

/** Milliseconds of the range the collector actually observed (gaps removed). */
function observedMs(o: OverviewData): number {
  if (!o.range) return 0;
  const { fromMs, toMs } = o.range;
  const gaps = o.gaps.map((g) => [Math.max(g.startMs, fromMs), Math.min(g.endMs ?? toMs, toMs)] as const).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let lost = 0;
  let cursor = fromMs;
  for (const [a, b] of gaps) {
    const s = Math.max(a, cursor);
    if (b > s) lost += b - s;
    cursor = Math.max(cursor, b);
  }
  return Math.max(0, toMs - fromMs - lost);
}

function readView(): "table" | "cards" {
  try {
    return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

export function RadarPage({ status }: { status: SourceStatus | null }) {
  const namespace = useNamespace();
  const now = useNow(5000);
  const narrow = useMediaQuery("(max-width: 860px)");
  const rule = useRule();
  const usdMin = ruleUsd(rule);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState({ minUsd: "", mint: "" });
  const [filterError, setFilterError] = useState<string | null>(null);
  const [items, setItems] = useState<PackListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewState, setOverviewState] = useState<"loading" | "ready" | "refreshing" | "unavailable">("loading");
  const [overviewAt, setOverviewAt] = useState<number | null>(null);
  const [view, setView] = useState<"table" | "cards">(readView);
  const shownView = narrow ? "cards" : view;
  const loadedIds = useRef(new Set<string>());
  const activeParams = useRef<Params>({});
  const statusRef = useRef(status);
  statusRef.current = status;
  const feedRef = useRef<HTMLElement | null>(null);
  const [guideDismissed, setGuideDismissed] = useState(() => {
    try {
      return localStorage.getItem("packlens.guide.dismissed") === "1";
    } catch {
      return false;
    }
  });
  const dismissGuide = () => {
    setGuideDismissed(true);
    try {
      localStorage.setItem("packlens.guide.dismissed", "1");
    } catch {
      /* private mode: the strip simply returns next visit */
    }
  };
  const showGuide = () => {
    setGuideDismissed(false);
    try {
      localStorage.removeItem("packlens.guide.dismissed");
    } catch {
      /* shown for this visit */
    }
  };
  const chooseView = (v: "table" | "cards") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the choice lasts for this visit */
    }
  };
  const refreshQueue = useRef(new Set<string>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    track("radar_viewed", "radar");
  }, []);

  const loadOverview = useCallback((params: Params, signal?: AbortSignal) => {
    setOverviewState((s) => (s === "ready" ? "refreshing" : s));
    apiGet<OverviewData>("/api/overview", params, signal)
      .then((res) => {
        setOverview(res.data);
        setOverviewAt(Date.now());
        setOverviewState("ready");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // An older server without the overview route: fall back to the source summary.
        if (err instanceof ApiError && err.status === 404) setOverviewState("unavailable");
        else setOverviewState((s) => (s === "refreshing" ? "ready" : "unavailable"));
      });
  }, []);

  const loadAll = useCallback(() => {
    const params: Params = { ...filterParams(filters, anchorFor(statusRef.current)), ...(namespace ? { namespace } : {}) };
    activeParams.current = params;
    setLoading(true);
    const ctrl = new AbortController();
    apiGet<PackListData>("/api/packs", { ...params, limit: PAGE }, ctrl.signal)
      .then((res) => {
        setItems(res.data.items);
        loadedIds.current = new Set(res.data.items.map((i) => i.core.id));
        setCursor(res.data.nextCursor);
        setError(null);
        setPendingNew(0);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Something went wrong.", null));
      })
      .finally(() => setLoading(false));
    loadOverview(params, ctrl.signal);
    return () => ctrl.abort();
  }, [filters, namespace, loadOverview]);

  useEffect(() => loadAll(), [loadAll]);

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    // Same parameters as the first page: the cursor is bound to this exact filter set.
    apiGet<PackListData>("/api/packs", { ...activeParams.current, limit: PAGE, cursor })
      .then((res) => {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.core.id));
          const next = [...prev, ...res.data.items.filter((i) => !seen.has(i.core.id))];
          loadedIds.current = new Set(next.map((i) => i.core.id));
          return next;
        });
        setCursor(res.data.nextCursor);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err : null))
      .finally(() => setLoadingMore(false));
  };

  // Coalesced in-place refresh of visible rows.
  const flushRefresh = useCallback(() => {
    refreshTimer.current = null;
    const ids = [...refreshQueue.current];
    refreshQueue.current.clear();
    for (const id of ids) {
      apiGet<PackDetail>(`/api/packs/${id}`, namespace ? { namespace } : {})
        .then((res) => {
          const fresh = itemFromDetail(res.data);
          setItems((prev) => prev.map((p) => (p.core.id === id && fresh.core.coreVersion >= p.core.coreVersion ? fresh : p)));
        })
        .catch(() => undefined);
    }
  }, [namespace]);

  const scheduleOverview = useCallback(() => {
    if (overviewTimer.current) return;
    overviewTimer.current = setTimeout(() => {
      overviewTimer.current = null;
      loadOverview(activeParams.current);
    }, 4000);
  }, [loadOverview]);

  useEffect(
    () => () => {
      if (overviewTimer.current) clearTimeout(overviewTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  useEventListener(
    (msg) => {
      if (msg.type === "resync_required") {
        setPendingNew((n) => n + 1);
        return;
      }
      if (msg.type === "pack.created") {
        if (filters.range.kind === "custom") return;
        if (!loadedIds.current.has(msg.aggregateId)) setPendingNew((n) => n + 1);
        scheduleOverview();
        return;
      }
      const packId = (msg.payload.packId as string | undefined) ?? msg.aggregateId;
      if (loadedIds.current.has(packId)) {
        refreshQueue.current.add(packId);
        if (!refreshTimer.current) refreshTimer.current = setTimeout(flushRefresh, 1500);
      }
    },
    [flushRefresh, scheduleOverview, filters.range.kind],
  );

  // Keep "after the pack" current on visible rows and the overview fresh (local data, no provider calls).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const ids = [...loadedIds.current].slice(0, 50);
      if (ids.length > 0) {
        apiGet<{ items: Record<string, AfterPackSummary> }>("/api/packs/after", { ids: ids.join(","), ...(namespace ? { namespace } : {}) })
          .then((res) => setItems((prev) => prev.map((p) => (res.data.items[p.core.id] ? { ...p, after: res.data.items[p.core.id]! } : p))))
          .catch(() => undefined);
      }
      loadOverview(activeParams.current);
    }, 20_000);
    return () => clearInterval(t);
  }, [namespace, loadOverview]);

  const applyText = () => {
    const minUsd = draft.minUsd.trim();
    const mint = draft.mint.trim();
    if (minUsd !== "" && !/^\d+(\.\d+)?$/.test(minUsd)) {
      setFilterError("Minimum total USD must be a number, for example 100.");
      return;
    }
    if (mint !== "" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      setFilterError("Token address must be a Solana mint address.");
      return;
    }
    setFilterError(null);
    if (minUsd !== filters.minUsd || mint !== filters.mint) setFilters((f) => ({ ...f, minUsd, mint }));
  };
  const onTextKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyText();
    } else if (e.key === "Escape") {
      setDraft({ minUsd: filters.minUsd, mint: filters.mint });
      setFilterError(null);
    }
  };
  const reset = () => {
    setDraft({ minUsd: "", mint: "" });
    setFilters(DEFAULT_FILTERS);
    setFilterError(null);
  };
  const selectInterval = (fromMs: number, toMs: number) => {
    setFilters((f) => ({ ...f, range: { kind: "custom", fromMs, toMs } }));
    requestAnimationFrame(() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
  const narrowingActive = filters.minWallets !== "3" || filters.minUsd !== "" || filters.mint !== "" || filters.confirmedOnly || filters.includeInvalidated;
  const showNew = () => {
    loadAll();
    feedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // While the reader is looking at the overview (the list is below the screen), new packs appear on their own.
  // Once they scroll into the list, rows stay put and the "new packs" button takes over.
  useEffect(() => {
    if (pendingNew === 0 || filters.range.kind === "custom") return;
    const t = setTimeout(() => {
      const top = feedRef.current?.getBoundingClientRect().top ?? 0;
      if (document.visibilityState === "visible" && top > window.innerHeight) loadAll();
    }, 3000);
    return () => clearTimeout(t);
  }, [pendingNew, loadAll, filters.range.kind]);
  // A column where every row says "not checked" is noise: say it once instead.
  const smAny = items.some((i) => i.smartMoney1h.countQualifier !== "unknown" || i.confirmedMemberCount !== null || i.analysisState !== "not_requested");

  const priceBlocked = status?.price.state === "waiting_for_price" || status?.price.state === "stale";
  const health = status?.collector.health;
  const disconnected = health === "disconnected" || health === "not_configured";
  const lastEvent = status?.collector.lastEventTimeMs ?? null;
  const o = overviewState === "unavailable" ? null : overview;
  const observed = o ? observedMs(o) : 0;
  const multiDay = o?.range ? o.range.toMs - o.range.fromMs > 36 * 3_600_000 : false;
  const rangeName = filters.range.kind === "custom" ? "Selected interval" : RANGES.find((r) => r.key === (filters.range as { key: RangeKey }).key)!.name;

  return (
    <div className="container radar">
      <header className="radar-head">
        <div className="radar-title">
          <div className="eyebrow">Solana · pump.fun</div>
          <h1 className="h1">
            Pack Radar<span className="h1-mark" aria-hidden="true">.</span>
          </h1>
          <p className="radar-sub">
            Live groups of wallets buying the same token at almost the same time, with the transactions behind them and what happened next.
            {guideDismissed && (
              <>
                {" "}
                <button type="button" className="text-link how-open" onClick={showGuide}>
                  <Question size={13} weight="bold" aria-hidden="true" /> How it works
                </button>
              </>
            )}
          </p>
        </div>
        <Reticle windowSeconds={rule.triggerWindowSeconds} joinSeconds={rule.expansionSeconds} />
        <dl className="head-facts">
          <div className={`fact${disconnected ? " warn" : ""}`}>
            <dt>Last source event</dt>
            <dd>
              <Decode text={lastEvent ? relative(lastEvent, now) : "n/a"} />
            </dd>
            <dd className="fact-note">{lastEvent ? `Chain time ${timeUtc(lastEvent)}` : "Waiting for events"}</dd>
          </div>
          <div className="fact">
            <dt>Last pack</dt>
            <dd>
              <Decode text={status?.latestPackTriggerMs ? relative(status.latestPackTriggerMs, now) : "n/a"} />
            </dd>
            <dd className="fact-note">{status?.latestPackTriggerMs ? timeUtc(status.latestPackTriggerMs) : "No packs detected yet"}</dd>
          </div>
          <div className="fact">
            <dt>Buys evaluated</dt>
            <dd>
              <Decode text={int(status?.counters.buys ?? null)} />
            </dd>
            <dd className="fact-note">{status ? `${int(status.counters.eligible)} eligible · ${int(status.counters.unvalued)} unvalued · ${int(status.counters.late)} late` : "n/a"}</dd>
          </div>
        </dl>
      </header>

      <div className="notices">
        {!guideDismissed && <HowItWorks onDismiss={dismissGuide} />}
        {disconnected && (
          <Note tone="yellow" icon="warn">
            {health === "not_configured" ? "The pump.fun source is not configured" : "The pump.fun source is disconnected"}
            {lastEvent ? `; the last event arrived ${relative(lastEvent, now)} (${timeUtc(lastEvent)})` : ""}. Stored packs remain readable, but new packs cannot be detected until it reconnects.
          </Note>
        )}
        {priceBlocked && status?.analysisPaused.paused ? (
          <Note tone="yellow" icon="warn">
            <strong>New packs are on hold.</strong> {status.analysisPaused.reason} Without a fresh SOL price, new buys cannot be valued, so none can pass the {usdMin} check. Stored packs and what happened after them stay
            readable. An operator can add credits to resume.
          </Note>
        ) : priceBlocked ? (
          <Note tone="yellow" icon="warn">
            {status?.price.state === "stale"
              ? `The SOL price is stale. Collection continues, but new buys cannot pass the ${usdMin} check until a valid ${status.price.provider === "pyth" ? "Pyth" : "Nansen"} price arrives.`
              : `Waiting for the first valid ${status?.price.provider === "pyth" ? "Pyth" : "Nansen"} SOL price. Buys are recorded but cannot pass the ${usdMin} check yet.`}
          </Note>
        ) : null}
        {!rule.isBaseline && (
          <p className="inline-note">
            Packs here follow a custom rule: {rule.minUniqueWallets} or more wallets, each buying {usdMin} or more within {rule.triggerWindowSeconds} seconds ({rule.version}). The spec baseline is 3 wallets and $20.
          </p>
        )}
        {status && status.mode === "live" && status.price.provider === "pyth" && (
          <p className="inline-note">
            Buys are valued with Pyth&apos;s on-chain SOL/USD price ({status.price.policyVersion}), published at most two minutes before each buy.
            <InfoTip
              label="the Pyth price"
              text="Pyth publishes a verified SOL/USD price on Solana about once a minute. Each buy uses the newest price published before it, fixed when the buy arrived. It costs no Nansen credits; Nansen is used for wallet, token, and Smart Money context. Detection rules are unchanged."
            />
          </p>
        )}
        {status && status.mode === "live" && status.price.provider === "nansen" && !status.price.isBaseline && (
          <p className="inline-note">
            Buys are valued with the documented {status.price.timeframe} price fallback ({status.price.policyVersion}), so values near {usdMin} are rougher estimates.
            <InfoTip
              label="the price fallback"
              text={`Nansen 1m SOL candles time out upstream, so buys are valued with the latest closed ${status.price.timeframe} candle, up to 15 minutes old. Detection rules are unchanged.`}
            />
          </p>
        )}
        {status?.analysisPaused.paused && !priceBlocked && (
          <Note tone="yellow" icon="warn">
            Analysis paused. {status.analysisPaused.reason} Pack detection continues.
          </Note>
        )}
      </div>

      <section className="toolbar" aria-labelledby="radar-filters">
        <h2 id="radar-filters" className="sr-only">
          Filters
        </h2>
        <div className="toolbar-row">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => {
              const active = filters.range.kind === "preset" && filters.range.key === r.key;
              return (
                <button key={r.key} type="button" aria-pressed={active} className={active ? "on" : ""} title={r.name} onClick={() => setFilters((f) => ({ ...f, range: { kind: "preset", key: r.key } }))}>
                  {r.label}
                </button>
              );
            })}
            {filters.range.kind === "custom" && (
              <span className="seg-custom on">
                {clockUtc(filters.range.fromMs)} to {clockUtc(filters.range.toMs)} UTC
                <button type="button" aria-label="Clear the selected interval" onClick={() => setFilters((f) => ({ ...f, range: DEFAULT_FILTERS.range }))}>
                  <X size={12} weight="bold" />
                </button>
              </span>
            )}
          </div>
          <div className="field inline">
            <label htmlFor="f-wallets">Min. wallets</label>
            <select
              id="f-wallets"
              className="select"
              value={String(Math.max(Number(filters.minWallets), rule.minUniqueWallets))}
              // The rule's minimum shows every pack, so it maps back to the default filter.
              onChange={(e) => setFilters((f) => ({ ...f, minWallets: Number(e.target.value) <= rule.minUniqueWallets ? DEFAULT_FILTERS.minWallets : e.target.value }))}
            >
              {[...new Set([String(rule.minUniqueWallets), ...["3", "4", "5", "6", "8", "10", "20", "50"].filter((v) => Number(v) > rule.minUniqueWallets)])].map((v) => (
                <option key={v} value={v}>
                  {v}+
                </option>
              ))}
            </select>
          </div>
          <div className="field inline">
            <label htmlFor="f-usd">Min. total pack USD</label>
            <input
              id="f-usd"
              className="input"
              inputMode="decimal"
              placeholder="Any"
              value={draft.minUsd}
              onChange={(e) => setDraft((d) => ({ ...d, minUsd: e.target.value }))}
              onKeyDown={onTextKey}
              onBlur={applyText}
              aria-invalid={filterError?.startsWith("Minimum") ? true : undefined}
            />
          </div>
          <div className="search">
            <MagnifyingGlass size={15} weight="bold" aria-hidden="true" />
            <label htmlFor="f-mint" className="sr-only">
              Token address
            </label>
            <input
              id="f-mint"
              className="input mono"
              placeholder="Token mint address"
              value={draft.mint}
              onChange={(e) => setDraft((d) => ({ ...d, mint: e.target.value }))}
              onKeyDown={onTextKey}
              onBlur={applyText}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={filterError?.startsWith("Token") ? true : undefined}
            />
          </div>
        </div>
        <div className="toolbar-row secondary">
          <label className="checkbox">
            <input type="checkbox" checked={filters.confirmedOnly} onChange={(e) => setFilters((f) => ({ ...f, confirmedOnly: e.target.checked }))} />
            Only packs with confirmed Smart Money members
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={filters.includeInvalidated} onChange={(e) => setFilters((f) => ({ ...f, includeInvalidated: e.target.checked }))} />
            Include invalidated packs
          </label>
          <span className="spacer" />
          {filtersActive && (
            <span className="active-filter small">
              <Tag tone="yellow">Filter active</Tag>
              {filters.confirmedOnly && <span className="muted">Showing packs with at least one confirmed Smart Money member.</span>}
              <button type="button" className="btn ghost sm" onClick={reset}>
                Reset
              </button>
            </span>
          )}
        </div>
        {filterError && (
          <div style={{ marginTop: 10 }}>
            <Note tone="red" icon="warn">
              {filterError}
            </Note>
          </div>
        )}
      </section>

      {overviewState === "unavailable" ? (
        <section className="kpis legacy" aria-label="Source summary">
          <Stat label="Packs detected" value={int(status?.packCount ?? null)} note="Persisted in this namespace" />
          <Stat label="Latest trigger" value={status?.latestPackTriggerMs ? relative(status.latestPackTriggerMs, now) : "n/a"} note={status?.latestPackTriggerMs ? timeUtc(status.latestPackTriggerMs) : "No packs detected yet"} />
          <Stat label="Buys evaluated" value={int(status?.counters.buys ?? null)} note={status ? `${int(status.counters.eligible)} eligible` : "n/a"} />
          <p className="small muted kpi-foot">Range totals and charts need the server's overview endpoint. Restart the server on this version to see them.</p>
        </section>
      ) : (
        <section className={`overview${overviewState === "refreshing" ? " refreshing" : ""}`} aria-labelledby="overview-title" aria-busy={overviewState === "loading"}>
          <div className="overview-head">
            <h2 id="overview-title" className="h2">
              {rangeName}
            </h2>
            <p className="small muted">
              {o?.range ? (
                <>
                  {clockUtc(o.range.fromMs, multiDay)} to {clockUtc(Math.ceil(o.range.toMs / 1000) * 1000, multiDay)} UTC · {span(observed)} observed
                  {o.gaps.length > 0 ? ` · ${o.gaps.length} ${o.gaps.length === 1 ? "disconnect" : "disconnects"}` : ""}
                  {narrowingActive ? " · filtered" : ""}
                  {overviewAt ? <span className="updated"> · updated {relative(overviewAt, now)}</span> : null}
                </>
              ) : overviewState === "loading" ? (
                "Loading…"
              ) : (
                "Nothing observed in this range yet."
              )}
            </p>
          </div>

          <div className="kpis">
            <Kpi hero label="Packs" tip="pack" value={o ? int(o.totals.packs) : null} note={o ? (observed >= 60_000 ? `${(o.totals.packs / (observed / 60_000)).toFixed(1)} per observed minute` : "In this range") : null} />
            <Kpi label="Pack buys" tip="packBuys" value={o ? usdCompact(o.totals.eligibleBuyUsd) : null} note={o ? "Eligible buys inside packs" : null} />
            <Kpi label="Tokens" value={o ? int(o.totals.tokens) : null} note={o ? `${int(o.totals.repeatTokens)} packed more than once` : null} />
            <Kpi label="Median pack" tip="uniqueWallets" value={o ? (o.totals.medianWallets === null ? "n/a" : `${o.totals.medianWallets} wallets`) : null} note={o ? (o.totals.maxWallets === null ? "No packs" : `Largest ${o.totals.maxWallets} · median entry window ${seconds(o.totals.medianEntrySpanMs)}`) : null} />
            <Kpi
              label="With repeat pairs"
              tip="cooccurrence"
              value={o ? (o.totals.packs > 0 ? `${Math.round((o.totals.repeatPairPacks / o.totals.packs) * 100)}%` : "n/a") : null}
              note={o ? `${int(o.totals.repeatPairPacks)} packs share a wallet pair with an earlier pack` : null}
            />
          </div>

          <div className="charts">
            <section className="panel chart-panel" aria-labelledby="activity-title">
              <header className="panel-head">
                <h3 id="activity-title" className="h3">
                  Packs over time
                </h3>
                <span className="tiny muted">{o?.range ? `Per ${span(o.bucketMs)} · click an interval to list its packs` : ""}</span>
              </header>
              {o?.range && o.buckets.length > 0 ? (
                <ActivityChart buckets={o.buckets} bucketMs={o.bucketMs} fromMs={o.range.fromMs} toMs={o.range.toMs} gaps={o.gaps} onSelect={selectInterval} />
              ) : overviewState === "loading" ? (
                <Skeleton height={214} />
              ) : (
                <p className="small muted panel-empty">No observed period in this range.</p>
              )}
            </section>
            <section className="panel" aria-labelledby="sizes-title">
              <header className="panel-head">
                <h3 id="sizes-title" className="h3">
                  Pack size
                </h3>
                <span className="tiny muted">Unique wallets per pack</span>
              </header>
              {o ? <SizeBands bands={o.sizeBands} total={o.totals.packs} /> : <Skeleton height={200} />}
            </section>
          </div>

          {o ? (
            <Highlights top={o.top} now={now} />
          ) : (
            <div className="highlights">
              {[0, 1, 2].map((i) => (
                <LoadingBlock key={i} label="Loading highlights" lines={4} />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="feed-section" ref={feedRef} aria-labelledby="radar-list" aria-busy={loading}>
        <header className="feed-head">
          <div>
            <h2 id="radar-list" className="h2">
              Packs
              <InfoTip k="pack" />
            </h2>
            <p className="small muted">
              {items.length > 0
                ? `Showing ${int(items.length)}${o ? ` of ${int(o.totals.packs)}` : ""}, newest first. Each row is one pack; price columns compare the token's latest trade with what the group paid.${smAny ? "" : " Smart Money has not been checked for these packs yet."}`
                : "Newest first"}
            </p>
          </div>
          {!narrow && (
            <div className="seg view-toggle" role="group" aria-label="Layout">
              <button type="button" aria-pressed={view === "table"} className={view === "table" ? "on" : ""} onClick={() => chooseView("table")}>
                <Rows size={15} weight="bold" aria-hidden="true" /> Table
              </button>
              <button type="button" aria-pressed={view === "cards"} className={view === "cards" ? "on" : ""} onClick={() => chooseView("cards")}>
                <SquaresFour size={15} weight="bold" aria-hidden="true" /> Cards
              </button>
            </div>
          )}
        </header>
        {pendingNew > 0 && (
          <div className="new-banner">
            <button type="button" className="btn primary" onClick={showNew}>
              <ArrowUp size={15} weight="bold" aria-hidden="true" /> {pendingNew === 1 ? "1 new pack" : `${pendingNew > 99 ? "99+" : pendingNew} new packs`} · Show
            </button>
          </div>
        )}
        <ErrorNote error={error} what="Packs" />
        {loading && items.length === 0 ? (
          <div className="stack" style={{ gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <LoadingBlock key={i} label="Loading packs" lines={2} />
            ))}
          </div>
        ) : items.length === 0 && !error ? (
          disconnected && !filtersActive ? (
            <Empty title="Source disconnected">The pump.fun stream is not connected, so no new packs can be detected. Stored packs remain readable.</Empty>
          ) : filtersActive ? (
            <Empty title="No packs match these filters">
              Try a longer time range or a lower minimum.{" "}
              <button type="button" className="text-link" onClick={reset}>
                Reset the filters
              </button>
            </Empty>
          ) : (
            <Empty title="No packs detected yet">
              The source is connected. A pack appears when at least {rule.minUniqueWallets} wallets each buy {usdMin} or more of the same token within {rule.triggerWindowSeconds} seconds.
            </Empty>
          )
        ) : (
          <div className={loading ? "feed-body refreshing" : "feed-body"}>
            {shownView === "table" ? (
              <PackTable items={items} now={now} showSmartMoney={smAny} />
            ) : (
              <div className="pack-grid">
                {items.map((item) => (
                  <PackCard key={item.core.id} item={item} now={now} />
                ))}
              </div>
            )}
          </div>
        )}
        {cursor && (
          <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
            <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
              <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> {loadingMore ? "Loading…" : "Load older packs"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, note, tip, hero }: { label: string; value: string | null; note: string | null; tip?: GlossaryKey; hero?: boolean }) {
  return (
    <div className={`kpi${hero ? " hero" : ""}`}>
      <span className="kpi-label">
        {label}
        {tip && <InfoTip k={tip} />}
      </span>
      {value === null ? <Skeleton width="60%" height={hero ? 72 : 30} style={{ margin: "14px 0 4px" }} /> : <Decode className="kpi-value" text={value} />}
      {note === null ? <Skeleton width="80%" height={12} /> : <span className="kpi-note">{note}</span>}
    </div>
  );
}
