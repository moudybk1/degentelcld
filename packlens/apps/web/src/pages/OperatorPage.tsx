import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { LockSimple, Play, SignOut, Stop } from "@phosphor-icons/react";
import type { Envelope, OperatorOverview } from "@packlens/contracts";
import { apiPost, apiRaw, ApiError } from "../api/client";
import { useNow } from "../api/hooks";
import { Address, Empty, KV, ModeBadge, Note, Reveal, Stat, Tag } from "../components/ui";
import { dateTimeUtc, int, relative, shortAddr, timeUtc } from "../lib/format";

function Login({ onDone, configured }: { onDone: () => void; configured: boolean }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!configured) {
    return (
      <Empty title="Operator access is not configured">Set ADMIN_TOKEN in the server environment to enable operator controls. Public pages remain read-only.</Empty>
    );
  }
  return (
    <form
      className="card login"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        apiRaw("/api/admin/login", { method: "POST", body: JSON.stringify({ token }) })
          .then(() => {
            setToken("");
            onDone();
          })
          .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Login failed."))
          .finally(() => setBusy(false));
      }}
    >
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <LockSimple size={18} weight="bold" aria-hidden="true" />
        <h2 className="h3">Operator login</h2>
      </div>
      <div className="field">
        <label htmlFor="op-token">Operator token</label>
        <input id="op-token" className="input mono" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} required />
      </div>
      <p className="tiny muted">The token is sent once and exchanged for an HttpOnly session cookie that lasts one hour. It is never stored in this browser.</p>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Note tone="red" icon="warn">{error}</Note>
        </div>
      )}
      <button className="btn primary" type="submit" disabled={busy || token.length === 0}>
        {busy ? "Checking…" : "Log in"}
      </button>
    </form>
  );
}

export function OperatorPage() {
  const now = useNow(5000);
  const [me, setMe] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [data, setData] = useState<OperatorOverview | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [duration, setDuration] = useState("60");
  const [dataset, setDataset] = useState("");
  const [replayMode, setReplayMode] = useState("recorded-arrival");
  const [pinMint, setPinMint] = useState("");

  const load = useCallback(() => {
    apiRaw<{ configured: boolean; authenticated: boolean }>("/api/admin/me")
      .then((m) => {
        setMe(m);
        if (!m.authenticated) return;
        return apiRaw<Envelope<OperatorOverview>>("/api/admin/overview").then((r) => {
          setData(r.data);
          setMode(r.mode);
          setError(null);
          setDataset((d) => d || r.data.datasets[0]?.id || "");
        });
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load operator data."));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The action failed.");
    }
  };

  if (!me) return <div className="container"><p className="muted">Loading…</p></div>;

  return (
    <div className="container">
      <Reveal>
        <div className="page-head">
          <div>
            <div className="row" style={{ gap: 8 }}>
              <div className="eyebrow">Operator</div>
              <ModeBadge mode={(mode as "live" | "fixture" | "replay" | null) ?? undefined} />
            </div>
            <h1 className="display">Sessions, credits and replay</h1>
            <p className="lede">Operational controls live here, apart from the research views. Only an authenticated operator can start work that spends credits.</p>
          </div>
          {me.authenticated && (
            <button type="button" className="btn ghost" onClick={() => void act(() => apiRaw("/api/admin/logout", { method: "POST", body: "{}" }), "Logged out.")}>
              <SignOut size={15} weight="bold" aria-hidden="true" /> Log out
            </button>
          )}
        </div>
      </Reveal>

      <div className="section" style={{ marginTop: 36 }}>
        {!me.authenticated ? (
          <Login configured={me.configured} onDone={load} />
        ) : !data ? (
          error ? <Note tone="red" icon="warn">{error}</Note> : <p className="muted">Loading operator data…</p>
        ) : (
          <div className="stack" style={{ gap: 48 }}>
            {message && (
              <div role="status">
                <Note>{message}</Note>
              </div>
            )}

            {/* Session and credits */}
            <section aria-labelledby="op-session">
              <div className="section-head">
                <h2 className="h2" id="op-session">Session and credits</h2>
                <span className="small muted">Campaign {data.usage.campaignId ?? "not started"} · the ledger survives restarts</span>
              </div>
              <div className="bento">
                <div className="card span-4">
                  <div className="card-title">
                    <h3 className="h3">Nansen session</h3>
                    {data.session.active ? <Tag tone="green" dot pulse>Active</Tag> : <Tag tone="outline">Inactive</Tag>}
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    <KV k="Ends">{data.session.endsAt ? `${dateTimeUtc(data.session.endsAt)} (${relative(data.session.endsAt, now)})` : "n/a"}</KV>
                    <KV k="Smart Money ends">{data.session.smartMoneyEndsAt ? dateTimeUtc(data.session.smartMoneyEndsAt) : "n/a"}</KV>
                    <KV k="Configured maximum">{data.session.configuredMaxEnd ? dateTimeUtc(data.session.configuredMaxEnd) : "Not set"}</KV>
                    <KV k="Nansen mode">
                      {data.config.nansenMode === "continuous"
                        ? "Continuous, renewed each UTC day under the daily cap"
                        : data.config.nansenMode === "off"
                          ? "Off (no session end or daily cap set)"
                          : "Bounded session"}
                    </KV>
                    <KV k="SOL price">{data.config.priceProvider === "pyth" ? "Pyth on-chain (no credits)" : "Nansen candles"}</KV>
                    <KV k="Smart Money feed">{data.config.smartMoneyFeedEnabled ? `Every ${data.config.smartMoneyPollSeconds} s` : "Off (per-pack lookups only)"}</KV>
                  </div>
                  {mode === "live" ? (
                    <div className="row" style={{ gap: 8, marginTop: 16 }}>
                      <select className="select" aria-label="Session duration" value={duration} onChange={(e) => setDuration(e.target.value)}>
                        {["15", "30", "60", "120", "240"].map((m) => (
                          <option key={m} value={m}>
                            {Number(m) >= 60 ? `${Number(m) / 60} h` : `${m} min`}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn primary sm" onClick={() => void act(() => apiPost("/api/admin/smart-money/session", { durationMinutes: Number(duration) }, { idempotent: true }), "Session started.")}>
                        <Play size={13} weight="bold" aria-hidden="true" /> {data.session.active ? "Restart" : "Start"}
                      </button>
                      {data.session.active && (
                        <button type="button" className="btn sm" onClick={() => void act(() => apiPost("/api/admin/session/end", {}), "Session ended. The ledger is kept.")}>
                          <Stop size={13} weight="bold" aria-hidden="true" /> End
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="tiny muted" style={{ marginTop: 14 }}>Fixture and replay modes never call providers.</p>
                  )}
                </div>
                <div className="card span-8">
                  <div className="card-title">
                    <h3 className="h3">Credits</h3>
                    <span className="small muted">Budget {data.usage.configuredBudget === null ? "not configured" : int(data.usage.configuredBudget)}</span>
                  </div>
                  {data.usage.configuredBudget ? (
                    <div className="meter" role="img" aria-label={`${data.usage.credits.settled} settled, ${data.usage.credits.reserved} reserved, ${data.usage.credits.unresolved} unresolved of ${data.usage.configuredBudget}`}>
                      <span className="settled" style={{ width: `${(100 * data.usage.credits.settled) / data.usage.configuredBudget}%` }} />
                      <span className="reserved" style={{ width: `${(100 * data.usage.credits.reserved) / data.usage.configuredBudget}%` }} />
                      <span className="unresolved" style={{ width: `${(100 * data.usage.credits.unresolved) / data.usage.configuredBudget}%` }} />
                    </div>
                  ) : null}
                  <div className="bento" style={{ marginTop: 18 }}>
                    <div className="span-3"><Stat label="Actual (settled)" value={int(data.usage.credits.settled)} /></div>
                    <div className="span-3"><Stat label="Reserved" value={int(data.usage.credits.reserved)} /></div>
                    <div className="span-3"><Stat label="Unresolved" value={int(data.usage.credits.unresolved)} note="Unknown cost; kept until reconciled" /></div>
                    <div className="span-3"><Stat label="Available" value={data.usage.credits.available === null ? "n/a" : int(data.usage.credits.available)} note={`Price reserve ${data.usage.credits.priceReserve}`} /></div>
                  </div>
                  {data.usage.credits.dailyCap !== null && (
                    <p className="small" style={{ margin: "14px 0 0" }}>
                      Today: {int(data.usage.credits.usedToday)} of {int(data.usage.credits.dailyCap)} credits (daily cap, resets at 00:00 UTC).
                    </p>
                  )}
                  <p className="tiny muted" style={{ margin: "14px 0 0" }}>
                    Account balance last reported by Nansen: {data.usage.credits.lastReportedRemaining === null ? "not reported yet" : int(data.usage.credits.lastReportedRemaining)}. The budget limits credits, never the number of calls.
                  </p>
                </div>
              </div>
            </section>

            {/* Usage */}
            <section aria-labelledby="op-usage">
              <div className="section-head">
                <h2 className="h2" id="op-usage">Nansen usage</h2>
                <a className="text-link small" href="/api/admin/usage/manifest" target="_blank" rel="noopener noreferrer">
                  Download usage manifest (JSON)
                </a>
              </div>
              <div className="bento">
                <div className="card span-3"><Stat label="Attempts" value={int(data.usage.attempts.total)} note="Every attempt, retry, and page" serif /></div>
                <div className="card span-3"><Stat label="Successful HTTP" value={int(data.usage.attempts.httpSuccess)} note={`${int(data.usage.attempts.httpFailed)} failed`} serif /></div>
                <div className="card span-3"><Stat label="Passed schema check" value={int(data.usage.attempts.schemaValid)} note={`${int(data.usage.attempts.schemaInvalid)} schema errors`} serif /></div>
                <div className="card span-3">
                  <Stat
                    label="Toward the 100-call target"
                    value={`${Math.min(100, Math.round((100 * data.usage.relevantSuccessful) / Math.max(1, data.usage.minimumTarget)))}%`}
                    note={`${int(data.usage.relevantSuccessful)} of ${data.usage.minimumTarget} relevant successful responses · ${int(data.usage.attempts.cacheHits)} cache hits (not calls)`}
                    serif
                  />
                </div>
              </div>
              {data.usage.byEndpoint.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 14 }}>
                  <table className="table">
                    <caption className="sr-only">Usage by endpoint</caption>
                    <thead>
                      <tr>
                        <th scope="col">Endpoint</th>
                        <th scope="col" className="num">Attempts</th>
                        <th scope="col" className="num">HTTP success</th>
                        <th scope="col" className="num">Schema valid</th>
                        <th scope="col" className="num">Actual credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.usage.byEndpoint.map((e) => (
                        <tr key={e.endpoint}>
                          <td className="mono small">{e.endpoint}</td>
                          <td className="num">{e.attempts}</td>
                          <td className="num">{e.httpSuccess}</td>
                          <td className="num">{e.schemaValid}</td>
                          <td className="num">{e.actualCredits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.usage.recent.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 14, maxHeight: 380, overflowY: "auto" }}>
                  <table className="table">
                    <caption className="sr-only">Recent attempts</caption>
                    <thead>
                      <tr>
                        <th scope="col">Started</th>
                        <th scope="col">Endpoint</th>
                        <th scope="col">Purpose</th>
                        <th scope="col">Subject</th>
                        <th scope="col" className="num">HTTP</th>
                        <th scope="col">Schema</th>
                        <th scope="col" className="num">Credits</th>
                        <th scope="col">Reservation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.usage.recent.map((r) => (
                        <tr key={r.attemptId}>
                          <td className="mono small">{timeUtc(r.startedAt)}</td>
                          <td className="mono small">{r.endpoint}</td>
                          <td className="small">{r.purpose.replace(/_/g, " ")}{r.retryOfAttemptId ? " (retry)" : ""}</td>
                          <td className="mono small">{r.subjectId ? shortAddr(r.subjectId) : "n/a"}</td>
                          <td className="num">{r.httpStatus ?? "n/a"}</td>
                          <td className="small">{r.normalizationStatus === "ok" ? "Valid" : r.normalizationStatus.replace(/_/g, " ")}</td>
                          <td className="num">{r.actualCredits ?? (r.quotedCredits !== null ? `~${r.quotedCredits}` : "n/a")}</td>
                          <td className="small">{r.reservationStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Source health and jobs */}
            <section aria-labelledby="op-health">
              <div className="section-head">
                <h2 className="h2" id="op-health">Source health and jobs</h2>
              </div>
              <div className="bento">
                <div className="card span-6">
                  <h3 className="h3" style={{ marginBottom: 12 }}>Collector</h3>
                  <div className="stack" style={{ gap: 8 }}>
                    <KV k="Health">{data.status.collector.health}</KV>
                    <KV k="Decoder">{data.status.decoderVersion}</KV>
                    <KV k="Config">{data.config.configVersion}</KV>
                    <KV k="Last message">{data.status.collector.lastMessageAt ? relative(data.status.collector.lastMessageAt, now) : "n/a"}</KV>
                    <KV k="Reconnects">{data.status.collector.reconnects}</KV>
                    <KV k="Notifications / failed tx">
                      {int(data.status.counters.notifications)} / {int(data.status.counters.failedTransactions)}
                    </KV>
                    <KV k="Decoded (buys / sells)">
                      {int(data.status.counters.decodedEvents)} ({int(data.status.counters.buys)} / {int(data.status.counters.sells)})
                    </KV>
                    <KV k="Eligible · unvalued · late">
                      {int(data.status.counters.eligible)} · {int(data.status.counters.unvalued)} · {int(data.status.counters.late)}
                    </KV>
                    <KV k="Undecodable · truncated logs">
                      {int(data.status.counters.undecodable)} · {int(data.status.counters.truncatedLogs)}
                    </KV>
                    <KV k="Gaps (open / total)">
                      {data.status.openGaps} / {data.status.totalGaps}
                    </KV>
                    <KV k="Price feed">
                      {data.status.price.state.replace(/_/g, " ")}
                      {data.status.price.latestCandleStart ? ` · ${data.status.price.provider === "pyth" ? "Pyth price" : "candle"} ${timeUtc(data.status.price.latestCandleStart)}` : ""}
                    </KV>
                  </div>
                  {data.status.analysisPaused.paused && (
                    <div style={{ marginTop: 14 }}>
                      <Note tone="yellow" icon="warn">
                        {data.status.analysisPaused.reason}{" "}
                        <button type="button" className="btn sm" onClick={() => void act(() => apiPost("/api/admin/pause/clear", {}), "Pause cleared; dispatch resumes if the cause is fixed.")}>
                          Clear pause
                        </button>
                      </Note>
                    </div>
                  )}
                </div>
                <div className="card span-6">
                  <h3 className="h3" style={{ marginBottom: 12 }}>Job queue</h3>
                  <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                    {Object.entries(data.jobs.counts).map(([k, v]) => (
                      <Tag key={k} tone={k === "failed" ? "red" : k === "budget_paused" ? "yellow" : k === "running" ? "blue" : "gray"}>
                        {k.replace(/_/g, " ")} {v}
                      </Tag>
                    ))}
                    {Object.keys(data.jobs.counts).length === 0 && <span className="small muted">No jobs yet.</span>}
                  </div>
                  <div className="stack" style={{ gap: 6, maxHeight: 300, overflowY: "auto" }}>
                    {data.jobs.recent.map((j) => (
                      <div className="kv small" key={j.id}>
                        <span className="k">
                          {j.type.replace(/_/g, " ")} <span className="mono tiny">{shortAddr(j.subject)}</span>
                        </span>
                        <span className="v">
                          {j.status.replace(/_/g, " ")}
                          {j.statusReason ? <span className="muted"> · {j.statusReason.replace(/_/g, " ")}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {data.errors.length > 0 && (
                <div className="card" style={{ marginTop: 12 }}>
                  <h3 className="h3" style={{ marginBottom: 12 }}>Recent operational errors</h3>
                  <div className="stack" style={{ gap: 6 }}>
                    {data.errors.map((e, i) => (
                      <div className="kv small" key={i}>
                        <span className="k mono">{timeUtc(e.at)}</span>
                        <span className="v">
                          {e.code}: {e.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Replay and demo pins */}
            <section aria-labelledby="op-replay">
              <div className="section-head">
                <h2 className="h2" id="op-replay">Replay and demo pins</h2>
              </div>
              <div className="bento">
                <div className="card span-6">
                  <h3 className="h3" style={{ marginBottom: 12 }}>Replay a registered dataset</h3>
                  <div className="row" style={{ gap: 8 }}>
                    <select className="select" aria-label="Dataset" value={dataset} onChange={(e) => setDataset(e.target.value)}>
                      {data.datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label} ({d.eventCount} events)
                        </option>
                      ))}
                    </select>
                    <select className="select" aria-label="Replay mode" value={replayMode} onChange={(e) => setReplayMode(e.target.value)}>
                      <option value="recorded-arrival">Recorded arrival</option>
                      <option value="historical-event-time">Historical event time</option>
                    </select>
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={!dataset}
                      onClick={() => void act(() => apiPost<{ namespace: string }>("/api/admin/replay", { datasetId: dataset, mode: replayMode }, { idempotent: true }), "Replay finished in a new namespace.")}
                    >
                      Run replay
                    </button>
                  </div>
                  <p className="tiny muted">Replays run on a virtual clock in their own namespace. They never call providers or change live data.</p>
                  <div className="stack" style={{ gap: 6, marginTop: 12 }}>
                    {data.replayRuns.map((r) => (
                      <div className="kv small" key={r.id}>
                        <span className="k">
                          <Link className="text-link" to={`/?namespace=${encodeURIComponent(r.namespace)}`}>
                            {r.datasetId}
                          </Link>{" "}
                          · {r.mode}
                        </span>
                        <span className="v mono tiny" title={r.resultHash ?? ""}>
                          digest {r.resultHash?.slice(0, 12) ?? "n/a"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card span-6">
                  <h3 className="h3" style={{ marginBottom: 12 }}>Demo pins</h3>
                  <form
                    className="row"
                    style={{ gap: 8 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(() => apiPost("/api/admin/demo-pins", { chain: "solana", mint: pinMint.trim(), enabled: true }, { idempotent: true }), "Token pinned.").then(() => setPinMint(""));
                    }}
                  >
                    <input className="input mono" style={{ flex: 1, minWidth: 200 }} placeholder="Token mint address" aria-label="Token mint address to pin" value={pinMint} onChange={(e) => setPinMint(e.target.value)} />
                    <button type="submit" className="btn sm" disabled={pinMint.trim().length < 32}>
                      Pin
                    </button>
                  </form>
                  <p className="tiny muted">Pinned tokens get Smart Money refreshes every 2 minutes and netflow every 5 minutes during a session. Pinning never creates a pack.</p>
                  <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                    {data.demoPins.map((p) => (
                      <div className="kv small" key={p.mint}>
                        <span className="k">
                          <Address value={p.mint} href={`/tokens/solana/${p.mint}`} />
                        </span>
                        <span className="v">
                          <button type="button" className="btn ghost sm" onClick={() => void act(() => apiPost("/api/admin/demo-pins", { chain: "solana", mint: p.mint, enabled: !p.enabled }, { idempotent: true }), p.enabled ? "Pin removed." : "Pinned.")}>
                            {p.enabled ? "Unpin" : "Pin again"}
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="op-analytics">
              <div className="section-head">
                <h2 className="h2" id="op-analytics">Local product analytics</h2>
                <span className="small muted">Aggregate counts only; no identities or addresses are stored.</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {data.analytics.length === 0 ? <span className="small muted">No events yet.</span> : data.analytics.map((a) => <Tag key={a.name}>{a.name.replace(/_/g, " ")} {a.count}</Tag>)}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
