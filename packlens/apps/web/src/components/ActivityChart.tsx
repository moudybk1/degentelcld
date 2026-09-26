import { useEffect, useMemo, useRef, useState } from "react";
import type { OverviewBucket } from "@packlens/contracts";
import { clockUtc, int, span, usd } from "../lib/format";

/**
 * Packs per interval: one series, columns from a single baseline, hairline
 * grid, per-column hover and keyboard tooltip, selective direct label on the
 * busiest interval, and a table-view twin. Collector gaps are shaded and
 * labeled so an unobserved period never reads as zero activity.
 */

type Gap = { startMs: number; endMs: number | null };

/** A round axis maximum that is even (so the midline tick is a whole number) and leaves little empty headroom. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = [1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((s) => n <= s)!;
  return Math.ceil((step * pow) / 2) * 2;
}

const TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60_000);

/** Time ticks on round UTC boundaries (every 5 min, 20 min, 1 h, ...), at most `max` of them. */
function timeTicks(fromMs: number, toMs: number, max: number): number[] {
  const step = TICK_STEPS.find((s) => (toMs - fromMs) / s <= max) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) ticks.push(t);
  return ticks;
}

/** Column path: square on every corner, drawn from the baseline up. */
function column(x: number, y: number, w: number, h: number): string {
  return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
}

export function ActivityChart({
  buckets,
  bucketMs,
  fromMs,
  toMs,
  gaps,
  onSelect,
}: {
  buckets: OverviewBucket[];
  bucketMs: number;
  fromMs: number;
  toMs: number;
  gaps: Gap[];
  onSelect?: (fromMs: number, toMs: number) => void;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(280, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = width < 520 ? 180 : 214;
  const m = { top: 20, right: 6, bottom: 26, left: 34 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const multiDay = toMs - fromMs > 36 * 3_600_000 || new Date(fromMs).getUTCDate() !== new Date(toMs).getUTCDate();

  const geo = useMemo(() => {
    const peak = buckets.reduce((a, b) => Math.max(a, b.packs), 0);
    const yMax = niceMax(peak);
    const yTicks = [0, yMax / 2, yMax];
    const xTicks = timeTicks(fromMs, toMs, width < 520 ? 3 : Math.max(4, Math.floor(width / 110)));
    const busiest = buckets.reduce<number>((best, b, i) => (b.packs > (buckets[best]?.packs ?? -1) ? i : best), 0);
    return { yMax, yTicks, xTicks, busiest, peak };
  }, [buckets, fromMs, toMs, width]);

  const x = (t: number) => m.left + ((Math.min(Math.max(t, fromMs), toMs) - fromMs) / Math.max(1, toMs - fromMs)) * iw;
  const y = (v: number) => m.top + (1 - v / geo.yMax) * ih;
  const slot = (bucketMs / Math.max(1, toMs - fromMs)) * iw;
  const colW = Math.max(1.5, Math.min(24, slot - 2));

  const bars = buckets.map((b) => {
    const x0 = x(b.startMs);
    const x1 = x(b.startMs + bucketMs);
    const cx = (x0 + x1) / 2;
    const w = Math.min(colW, Math.max(1.5, x1 - x0 - 2));
    return { ...b, cx, w, endMs: b.startMs + bucketMs };
  });
  const gapBands = gaps.map((g) => ({ x0: x(g.startMs), x1: x(g.endMs ?? toMs), open: g.endMs === null })).filter((g) => g.x1 - g.x0 >= 1);
  const overlapsGap = (s: number, e: number) => gaps.some((g) => g.startMs < e && (g.endMs ?? Infinity) > s);

  const nearest = (px: number) => {
    let best = 0;
    let bd = Infinity;
    bars.forEach((b, i) => {
      const d = Math.abs(b.cx - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const hb = hover !== null ? bars[hover] : null;
  const tipLeft = hb ? Math.min(Math.max(hb.cx + 14, 8), width - 220) : 0;
  const total = buckets.reduce((a, b) => a + b.packs, 0);
  const busiest = bars[geo.busiest];
  const label = (t: number) => clockUtc(t, multiDay);

  return (
    <div>
      <div className="chart-wrap activity" ref={wrap}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-label={`Packs per ${span(bucketMs)} from ${label(fromMs)} to ${label(toMs)} UTC. ${int(total)} packs in total${busiest && busiest.packs > 0 ? `; busiest interval ${label(busiest.startMs)} with ${busiest.packs}` : ""}. Use the arrow keys to read intervals${onSelect ? " and Enter to show the packs in one" : ""}.`}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            setHover(nearest(e.clientX - r.left));
          }}
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (hb && onSelect && hb.packs > 0) onSelect(Math.max(hb.startMs, fromMs), Math.min(hb.endMs, toMs));
          }}
          onKeyDown={(e) => {
            if (bars.length === 0) return;
            if (e.key === "ArrowRight") setHover((h) => Math.min(bars.length - 1, (h ?? -1) + 1));
            else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? bars.length) - 1));
            else if (e.key === "Escape") setHover(null);
            else if (e.key === "Enter" && hb && onSelect && hb.packs > 0) onSelect(Math.max(hb.startMs, fromMs), Math.min(hb.endMs, toMs));
            else return;
            e.preventDefault();
          }}
          onBlur={() => setHover(null)}
          style={{ cursor: onSelect && hb && hb.packs > 0 ? "pointer" : "default" }}
        >
          {gapBands.map((g, i) => (
            <g key={`g${i}`} className="gap-band">
              <rect x={g.x0} y={m.top} width={g.x1 - g.x0} height={ih} />
              {g.x1 - g.x0 > 64 && (
                <text x={(g.x0 + g.x1) / 2} y={m.top + 14} textAnchor="middle">
                  {g.open ? "Disconnected" : "Not observed"}
                </text>
              )}
            </g>
          ))}
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className={v === 0 ? "axis" : "grid"} x1={m.left} x2={m.left + iw} y1={y(v)} y2={y(v)} />
              <text className="tick" x={m.left - 8} y={y(v) + 4} textAnchor="end">
                {int(v)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t) => {
            const px = x(t);
            // Keep edge labels inside the plot instead of clipping them.
            const anchor = px - m.left < 24 ? "start" : m.left + iw - px < 24 ? "end" : "middle";
            return (
              <g key={t}>
                <line className="grid" x1={px} x2={px} y1={y(0)} y2={y(0) + 4} />
                <text className="tick" x={px} y={height - 7} textAnchor={anchor}>
                  {label(t)}
                </text>
              </g>
            );
          })}
          {bars.map((b, i) =>
            b.packs > 0 ? (
              <path
                key={b.startMs}
                className={`col${hover === i ? " hover" : ""}${hover !== null && hover !== i ? " dim" : ""}`}
                d={column(b.cx - b.w / 2, y(b.packs), b.w, y(0) - y(b.packs))}
                style={{ ["--i" as string]: i }}
              />
            ) : null,
          )}
          {busiest && busiest.packs > 0 && hover === null && (
            <text
              className="peak-label"
              x={Math.min(Math.max(busiest.cx, m.left + 30), m.left + iw - 30)}
              y={Math.max(y(busiest.packs) - 7, m.top - 6)}
              textAnchor="middle"
            >
              {busiest.packs}
            </text>
          )}
          {hb && <line className="crosshair" x1={hb.cx} x2={hb.cx} y1={m.top} y2={m.top + ih} pointerEvents="none" />}
        </svg>
        {hb && (
          <div className="chart-tip" style={{ left: tipLeft, top: 4 }} role="status">
            <div className="v">
              {int(hb.packs)} {hb.packs === 1 ? "pack" : "packs"}
            </div>
            <div className="muted tiny">
              {label(Math.max(hb.startMs, fromMs))} to {label(Math.min(hb.endMs, toMs))} UTC
            </div>
            {hb.packs > 0 && <div className="tiny" style={{ marginTop: 4 }}>{usd(hb.eligibleBuyUsd)} in pack buys</div>}
            {overlapsGap(hb.startMs, hb.endMs) && <div className="tiny muted" style={{ marginTop: 4 }}>The source was disconnected for part of this interval.</div>}
            {onSelect && hb.packs > 0 && <div className="tiny tip-hint">Click to list these packs</div>}
          </div>
        )}
      </div>
      <div className="chart-foot">
        {gapBands.length > 0 && (
          <span className="legend-item">
            <i className="swatch gap" aria-hidden="true" />
            Source disconnected: nothing observed, not zero activity
          </span>
        )}
        <details className="table-toggle">
          <summary>Show as a table</summary>
          <div className="table-wrap chart-table">
            <table className="table compact">
              <caption className="sr-only">Packs and pack buys per interval</caption>
              <thead>
                <tr>
                  <th scope="col">Interval (UTC)</th>
                  <th scope="col" className="num">Packs</th>
                  <th scope="col" className="num">Pack buys</th>
                </tr>
              </thead>
              <tbody>
                {bars.filter((b) => b.packs > 0 || overlapsGap(b.startMs, b.endMs)).map((b) => (
                  <tr key={b.startMs}>
                    <td className="mono">
                      {label(Math.max(b.startMs, fromMs))} to {label(Math.min(b.endMs, toMs))}
                      {overlapsGap(b.startMs, b.endMs) ? <span className="muted"> · partly disconnected</span> : null}
                    </td>
                    <td className="num">{int(b.packs)}</td>
                    <td className="num">{b.packs > 0 ? usd(b.eligibleBuyUsd) : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}
