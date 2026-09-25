import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowUp, ArrowsClockwise, BookOpenText, FunnelSimple, X } from "@phosphor-icons/react";
import type { AfterPackSummary, PackDetail, PackListData, PackListItem, SourceStatus } from "@packlens/contracts";
import { apiGet, ApiError, track } from "../api/client";
import { useEventListener } from "../api/events";
import { useNow } from "../api/hooks";
import { PackCard } from "../components/PackCard";
import { Empty, ErrorNote, LoadingBlock, Note, Reveal, Stat, Tag } from "../components/ui";
import { int, relative, timeUtc } from "../lib/format";
import { useNamespace, useNsHref } from "../state/namespace";

type Filters = { minWallets: string; minUsd: string; mint: string; window: string; confirmedOnly: boolean; includeInvalidated: boolean };
const DEFAULT_FILTERS: Filters = { minWallets: "3", minUsd: "", mint: "", window: "all", confirmedOnly: false, includeInvalidated: false };

function filterParams(f: Filters, now: number): Record<string, string | undefined> {
  const hours: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24 };
  return {
    minWallets: f.minWallets,
    minUsd: f.minUsd.trim() === "" ? undefined : f.minUsd.trim(),
    mint: f.mint.trim() === "" ? undefined : f.mint.trim(),
    from: f.window in hours ? new Date(now - hours[f.window]! * 3_600_000).toISOString() : undefined,
    confirmedSmartMoneyOnly: f.confirmedOnly ? "true" : undefined,
    includeInvalidated: f.includeInvalidated ? "true" : undefined,
  };
}

/** Derive a card from a detail snapshot, so enrichment updates a card in place without reordering. */
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

function versionOf(i: PackListItem): number {
  return i.core.coreVersion;
}

export function RadarPage({ status }: { status: SourceStatus | null }) {
  const namespace = useNamespace();
  const now = useNow(5000);
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [items, setItems] = useState<PackListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const [mode, setMode] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const loadedIds = useRef(new Set<string>());
  const href = useNsHref();
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
  const refreshQueue = useRef(new Set<string>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    track("radar_viewed", "radar");
  }, []);

  const loadFirst = useCallback(() => {
    setLoading(true);
    const ctrl = new AbortController();
    apiGet<PackListData>("/api/packs", { ...filterParams(filters, Date.now()), limit: 24, ...(namespace ? { namespace } : {}) }, ctrl.signal)
      .then((res) => {
        setItems(res.data.items);
        loadedIds.current = new Set(res.data.items.map((i) => i.core.id));
        setCursor(res.data.nextCursor);
        setMode(res.mode);
        setError(null);
        setPendingNew(0);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Something went wrong.", null));
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [filters, namespace]);

  useEffect(() => loadFirst(), [loadFirst]);

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    apiGet<PackListData>("/api/packs", { ...filterParams(filters, Date.now()), limit: 24, cursor, ...(namespace ? { namespace } : {}) })
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

  // Coalesced in-place refresh of visible cards.
  const flushRefresh = useCallback(() => {
    refreshTimer.current = null;
    const ids = [...refreshQueue.current];
    refreshQueue.current.clear();
    for (const id of ids) {
      apiGet<PackDetail>(`/api/packs/${id}`, namespace ? { namespace } : {})
        .then((res) => {
          const fresh = itemFromDetail(res.data);
          setItems((prev) => prev.map((p) => (p.core.id === id && versionOf(fresh) >= versionOf(p) ? fresh : p)));
        })
        .catch(() => undefined);
    }
  }, [namespace]);

  useEventListener(
    (msg) => {
      if (msg.type === "resync_required") {
        setPendingNew((n) => n + 1);
        return;
      }
      if (msg.type === "pack.created") {
        if (!loadedIds.current.has(msg.aggregateId)) setPendingNew((n) => n + 1);
        return;
      }
      const packId = (msg.payload.packId as string | undefined) ?? msg.aggregateId;
      if (loadedIds.current.has(packId)) {
        refreshQueue.current.add(packId);
        if (!refreshTimer.current) refreshTimer.current = setTimeout(flushRefresh, 1500);
      }
    },
    [flushRefresh],
  );

  // Keep the "after the pack" line current on visible cards (local data, no provider calls).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const ids = [...loadedIds.current].slice(0, 50);
      if (ids.length === 0) return;
      apiGet<{ items: Record<string, AfterPackSummary> }>("/api/packs/after", { ids: ids.join(","), ...(namespace ? { namespace } : {}) })
        .then((res) => setItems((prev) => prev.map((p) => (res.data.items[p.core.id] ? { ...p, after: res.data.items[p.core.id]! } : p))))
        .catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, [namespace]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.minUsd.trim() !== "" && !/^\d+(\.\d+)?$/.test(draft.minUsd.trim())) {
      setFilterError("Minimum total USD must be a number, for example 100.");
      return;
    }
    if (draft.mint.trim() !== "" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(draft.mint.trim())) {
      setFilterError("Token address must be a Solana mint address.");
      return;
    }
    setFilterError(null);
    setFilters(draft);
  };
  const reset = () => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setFilterError(null);
  };
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  const health = status?.collector.health;
  const disconnected = health === "disconnected" || health === "not_configured";
  const lastEvent = status?.collector.lastEventTimeMs ?? null;

  return (
    <div className="container">
      <Reveal>
        <div className="page-head">
          <div>
            <div className="eyebrow">Solana · pump.fun · confirmed commitment</div>
            <h1 className="display">
              Pack Radar <em>— grouped buys, with evidence.</em>
            </h1>
            <p className="lede">
              Three or more wallets buying the same token, at least $20 each, within 20 seconds. Every pack keeps the transactions that formed it.
            </p>
          </div>
        </div>
      </Reveal>

      {!guideDismissed && (
        <div className="onboard" style={{ marginTop: 32 }}>
          <BookOpenText size={22} weight="bold" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ color: "var(--ink)" }}>New to PackLens?</strong>{" "}
            <span className="muted">Learn what each number means, how to tell facts from Nansen context, and seven questions to ask before acting on a pack.</span>
          </div>
          <Link className="btn primary sm" to={href("/guide")}>
            Read the 3-minute guide
          </Link>
          <button type="button" className="icon-btn" aria-label="Hide this guide suggestion" onClick={dismissGuide}>
            <X size={14} weight="bold" />
          </button>
        </div>
      )}

      <Reveal index={1} className="section" style={{ marginTop: 32 }}>
        <div className="bento">
          <div className="card span-3">
            <Stat label="Packs detected" value={int(status?.packCount ?? null)} note={mode === "fixture" ? "Synthetic fixture" : mode === "replay" ? "Replay namespace" : "Persisted in this namespace"} serif />
          </div>
          <div className="card span-3">
            <Stat
              label="Latest trigger"
              value={status?.latestPackTriggerMs ? relative(status.latestPackTriggerMs, now) : "—"}
              note={status?.latestPackTriggerMs ? timeUtc(status.latestPackTriggerMs) : "No packs detected yet"}
              serif
            />
          </div>
          <div className="card span-3">
            <Stat
              label="Latest source event"
              value={lastEvent ? relative(lastEvent, now) : "—"}
              note={lastEvent ? `Chain time ${timeUtc(lastEvent)}` : "Waiting for events"}
              serif
            />
          </div>
          <div className="card span-3">
            <Stat
              label="Buys evaluated"
              value={int(status?.counters.buys ?? null)}
              note={status ? `${int(status.counters.eligible)} eligible · ${int(status.counters.unvalued)} unvalued · ${int(status.counters.late)} late` : "—"}
              serif
            />
          </div>
        </div>
      </Reveal>

      {status?.price.state === "waiting_for_price" || status?.price.state === "stale" ? (
        <div style={{ marginTop: 16 }}>
          <Note tone="yellow" icon="warn">
            {status.price.state === "stale"
              ? "Quote price is stale. Collection continues, but new buys cannot pass the $20 check until a valid Nansen price arrives."
              : "Waiting for the first valid Nansen quote price. Buys are recorded but cannot pass the $20 check yet."}
          </Note>
        </div>
      ) : null}
      {status && status.mode === "live" && !status.price.isBaseline && (
        <div style={{ marginTop: 16 }}>
          <Note tone="blue">
            Quote price uses the documented {status.price.timeframe} fallback ({status.price.policyVersion}): Nansen 1-minute SOL candles time out upstream, so buys are valued with the latest
            closed {status.price.timeframe} candle, up to 15 minutes old. Values near $20 are rougher estimates. Detection rules are unchanged.
          </Note>
        </div>
      )}
      {status?.analysisPaused.paused && (
        <div style={{ marginTop: 16 }}>
          <Note tone="yellow" icon="warn">Analysis paused. {status.analysisPaused.reason} Pack detection continues.</Note>
        </div>
      )}

      <section className="section" style={{ marginTop: 40 }} aria-labelledby="radar-filters">
        <h2 id="radar-filters" className="sr-only">
          Filters
        </h2>
        <form className="filters" onSubmit={apply}>
          <div className="field">
            <label htmlFor="f-wallets">Min. wallets</label>
            <select id="f-wallets" className="select" value={draft.minWallets} onChange={(e) => setDraft({ ...draft, minWallets: e.target.value })}>
              {["3", "4", "5", "6", "8", "10"].map((v) => (
                <option key={v} value={v}>
                  {v}+
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-usd">Min. total pack USD</label>
            <input id="f-usd" className="input" inputMode="decimal" placeholder="Any" value={draft.minUsd} onChange={(e) => setDraft({ ...draft, minUsd: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-mint">Token address</label>
            <input id="f-mint" className="input mono" placeholder="Exact mint address" value={draft.mint} onChange={(e) => setDraft({ ...draft, mint: e.target.value })} spellCheck={false} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="f-window">Triggered</label>
            <select id="f-window" className="select" value={draft.window} onChange={(e) => setDraft({ ...draft, window: e.target.value })}>
              <option value="all">Any time</option>
              <option value="1h">Last hour</option>
              <option value="6h">Last 6 hours</option>
              <option value="24h">Last 24 hours</option>
            </select>
          </div>
          <div className="row filters-actions" style={{ gap: 8 }}>
            <button type="submit" className="btn primary">
              <FunnelSimple size={15} weight="bold" aria-hidden="true" /> Apply
            </button>
            <button type="button" className="btn ghost" onClick={reset} disabled={!filtersActive && JSON.stringify(draft) === JSON.stringify(DEFAULT_FILTERS)}>
              Reset
            </button>
          </div>
        </form>
        <div className="filters-foot">
          <label className="checkbox">
            <input type="checkbox" checked={draft.confirmedOnly} onChange={(e) => setDraft({ ...draft, confirmedOnly: e.target.checked })} />
            Only packs with confirmed Smart Money members
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.includeInvalidated} onChange={(e) => setDraft({ ...draft, includeInvalidated: e.target.checked })} />
            Include invalidated packs
          </label>
          <span className="spacer" />
          {filtersActive ? (
            <span className="active-filter small">
              <Tag tone="yellow">Filter active</Tag>
              {filters.confirmedOnly && <span className="muted">Smart Money filter on: showing packs with at least one confirmed member.</span>}
            </span>
          ) : (
            <span className="small muted">Newest trigger first. Enrichment never reorders cards.</span>
          )}
        </div>
        {filterError && (
          <div style={{ marginTop: 10 }}>
            <Note tone="red" icon="warn">{filterError}</Note>
          </div>
        )}
      </section>

      <section className="section" style={{ marginTop: 28 }} aria-labelledby="radar-list" aria-busy={loading}>
        <h2 id="radar-list" className="sr-only">
          Packs
        </h2>
        {pendingNew > 0 && (
          <div className="new-banner">
            <button type="button" className="btn primary" onClick={() => { loadFirst(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
              <ArrowUp size={15} weight="bold" aria-hidden="true" /> New packs available · Show
            </button>
          </div>
        )}
        <ErrorNote error={error} what="Packs" />
        {loading && items.length === 0 ? (
          <div className="pack-grid">
            {[0, 1, 2, 3].map((i) => (
              <LoadingBlock key={i} label="Loading packs" lines={4} />
            ))}
          </div>
        ) : items.length === 0 && !error ? (
          disconnected ? (
            <Empty title="Source disconnected">The pump.fun stream is not connected, so no new packs can be detected. Stored packs remain readable.</Empty>
          ) : filtersActive ? (
            <Empty title="No packs match these filters">Try a lower minimum or reset the filters.</Empty>
          ) : (
            <Empty title="No packs detected yet">The source is connected. A pack appears when at least three wallets make eligible buys of the same token within 20 seconds.</Empty>
          )
        ) : (
          <div className="pack-grid">
            {items.map((item, i) => (
              <Reveal key={item.core.id} index={i % 6}>
                <PackCard item={item} now={now} />
              </Reveal>
            ))}
          </div>
        )}
        {cursor && (
          <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
            <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
              <ArrowsClockwise size={15} weight="bold" aria-hidden="true" /> {loadingMore ? "Loading…" : "Load older packs"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
