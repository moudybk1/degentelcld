import { useEffect, useMemo, useRef, useState } from "react";
import type { AfterPackMarker, AfterPackPoint } from "@packlens/contracts";
import { shortAddr, timeUtc } from "../lib/format";

/**
 * Price after the pack: one line (latest trade price vs the pack's average
 * entry, in %), markers for pack buys (circle) and pack-wallet sells
 * (down-triangle). One axis, hairline grid, crosshair tooltip with keyboard
 * support, selective direct labels, and a table-view twin.
 */
const INK = "#EAEAEA"; // white phosphor price line
const BUY = "#FF2A2A"; // hazard red: pack buys are the focus
const SELL = "#0A0A0A"; // hollow triangle with a light outline, so sells differ by shape and fill
const SELL_EDGE = "#EAEAEA";
const GRID = "#1F1F22";
const ZERO = "#46464C";
const TICK = "#8D8D93";
const SURFACE = "#111112";
const MONO = "IBM Plex Mono, ui-monospace, monospace";

function niceStep(range: number, target = 4): number {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

const ZOOMS: { label: string; ms: number | null }[] = [
  { label: "First 2 min", ms: 120_000 },
  { label: "First 15 min", ms: 900_000 },
  { label: "All", ms: null },
];

export function signed(p: number): string {
  const r = Math.abs(p) >= 100 ? Math.round(p) : Math.round(p * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
}

export function AfterChart({
  series,
  markers,
  triggerMs,
  peak: truePeak = null,
}: {
  series: AfterPackPoint[];
  markers: AfterPackMarker[];
  triggerMs: number;
  /** The highest trade after the pack, from all trades; labels the chart so it matches the stat tile. */
  peak?: { changePct: number; at: string } | null;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(760);
  const [hover, setHover] = useState<number | null>(null);
  // Most moves happen in the first seconds; a long tail would squeeze them into a sliver.
  const spanMs = (series[series.length - 1]?.t ?? triggerMs) - triggerMs;
  const zooms = ZOOMS.filter((z) => z.ms === null || spanMs > z.ms * 1.5);
  const [zoom, setZoom] = useState<number | null>(() => (spanMs > 4 * 60_000 ? 120_000 : null));
  const limit = zoom === null ? Infinity : triggerMs + zoom;
  const view = zoom === null ? series : series.filter((p) => p.t <= limit);
  const viewMarkers = zoom === null ? markers : markers.filter((p) => p.t <= limit);

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

  const height = width < 520 ? 230 : 280;
  const m = { top: 22, right: width < 520 ? 52 : 70, bottom: 30, left: width < 520 ? 46 : 56 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  const geo = useMemo(() => {
    const ts = [...view.map((p) => p.t), ...viewMarkers.map((p) => p.t), triggerMs];
    const ys = [...view.map((p) => p.changePct), ...viewMarkers.map((p) => p.changePct), 0];
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts, t0 + 1000);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (y1 - y0 < 4) {
      y0 -= 2;
      y1 += 2;
    }
    const step = niceStep(y1 - y0);
    y0 = Math.floor(y0 / step) * step;
    y1 = Math.ceil(y1 / step) * step;
    const yTicks: number[] = [];
    for (let v = y0; v <= y1 + step / 2; v += step) yTicks.push(Math.round(v * 1000) / 1000);
    const xTicks: number[] = [];
    const n = width < 520 ? 3 : 5;
    for (let i = 0; i <= n; i++) xTicks.push(t0 + ((t1 - t0) * i) / n);
    return { t0, t1, y0, y1, yTicks, xTicks };
  }, [view, viewMarkers, triggerMs, width]);

  const x = (t: number) => m.left + ((t - geo.t0) / (geo.t1 - geo.t0)) * iw;
  const y = (v: number) => m.top + (1 - (v - geo.y0) / (geo.y1 - geo.y0)) * ih;
  const path = view.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.changePct).toFixed(1)}`).join("");
  const last = view[view.length - 1];
  const peakAll = truePeak ? { t: Date.parse(truePeak.at), changePct: truePeak.changePct } : null;
  const peak = peakAll && peakAll.t <= limit
    ? peakAll
    : view.reduce<AfterPackPoint | null>((a, p) => (p.t > triggerMs && (!a || p.changePct > a.changePct) ? p : a), null);

  const nearest = (px: number) => {
    let best = 0;
    let bd = Infinity;
    view.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const hp = hover !== null ? view[hover] : null;
  const bucketMs = view.length > 1 ? (geo.t1 - geo.t0) / Math.max(1, view.length) : 2000;
  const near = hp ? viewMarkers.filter((mk) => Math.abs(mk.t - hp.t) <= Math.max(1000, bucketMs)) : [];
  const tipLeft = hp ? Math.min(Math.max(x(hp.t) + 12, 8), width - 250) : 0;

  const tri = (cx: number, cy: number, r: number) => `${cx - r},${cy - r * 0.75} ${cx + r},${cy - r * 0.75} ${cx},${cy + r}`;

  return (
    <div>
      {zooms.length > 1 && (
        <div className="seg chart-zoom" role="group" aria-label="Time shown">
          {zooms.map((z) => (
            <button key={z.label} type="button" aria-pressed={zoom === z.ms} className={zoom === z.ms ? "on" : ""} onClick={() => setZoom(z.ms)}>
              {z.label}
            </button>
          ))}
        </div>
      )}
      <div className="chart-legend" aria-hidden="true">
        <span>
          <svg width="18" height="10"><line x1="1" y1="5" x2="17" y2="5" stroke={INK} strokeWidth="2" strokeLinecap="round" /></svg>
          Trade price vs pack entry
        </span>
        <span>
          <svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill={BUY} stroke={SURFACE} strokeWidth="2" /></svg>
          Pack buy
        </span>
        <span>
          <svg width="12" height="12"><polygon points={tri(6, 6, 5)} fill={SELL} stroke={SELL_EDGE} strokeWidth="1.5" /></svg>
          Pack wallet sell
        </span>
      </div>
      <div className="chart-wrap" ref={wrap}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-label={`Price after the pack. ${zoom === null ? "Latest" : "At the end of the period shown"} ${last ? signed(last.changePct) : "not available"} versus the pack's average entry${peak ? `, peak ${signed(peak.changePct)}` : ""}. Use the arrow keys to read points.`}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            setHover(nearest(e.clientX - r.left));
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (view.length === 0) return;
            if (e.key === "ArrowRight") setHover((h) => Math.min(view.length - 1, (h ?? -1) + 1));
            else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? view.length) - 1));
            else if (e.key === "Escape") setHover(null);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setHover(null)}
        >
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line x1={m.left} x2={m.left + iw} y1={y(v)} y2={y(v)} stroke={v === 0 ? ZERO : GRID} strokeWidth="1" strokeDasharray={v === 0 ? undefined : "2 3"} />
              <text x={m.left - 8} y={y(v) + 4} textAnchor="end" fontSize="10" fill={TICK} fontFamily={MONO} style={{ fontVariantNumeric: "tabular-nums" }}>
                {v === 0 ? "0%" : signed(v)}
              </text>
            </g>
          ))}
          <text
            x={m.left + iw - 4}
            y={last && Math.abs(y(last.changePct) - y(0)) < 18 && y(last.changePct) <= y(0) ? y(0) + 15 : y(0) - 6}
            textAnchor="end"
            fontSize="10"
            fill={TICK}
            fontFamily={MONO}
            letterSpacing="0.08em"
            stroke={SURFACE}
            strokeWidth="3"
            paintOrder="stroke"
          >
            PACK ENTRY
          </text>
          {geo.xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === geo.xTicks.length - 1 ? "end" : "middle"} fontSize="10" fill={TICK} fontFamily={MONO} style={{ fontVariantNumeric: "tabular-nums" }}>
              {timeUtc(t).replace(" UTC", "")}
            </text>
          ))}
          <line x1={x(triggerMs)} x2={x(triggerMs)} y1={m.top} y2={m.top + ih} stroke={BUY} strokeWidth="1" strokeDasharray="3 3" />
          <text x={x(triggerMs) + 6} y={m.top - 8} fontSize="10" fill={BUY} fontFamily={MONO} letterSpacing="0.08em">
            PACK FORMED
          </text>
          <path key={zoom ?? "all"} className="draw" pathLength={1} d={path} fill="none" stroke={INK} strokeWidth="1.6" strokeLinejoin="miter" strokeLinecap="square" />
          {viewMarkers.filter((mk) => mk.kind === "pack_buy").map((mk, i) => (
            <circle key={`b${i}`} className="mark-in" style={{ ["--i" as string]: i }} cx={x(mk.t)} cy={y(mk.changePct)} r="4.5" fill={BUY} stroke={SURFACE} strokeWidth="2" />
          ))}
          {viewMarkers.filter((mk) => mk.kind === "member_sell").map((mk, i) => (
            <polygon key={`s${i}`} className="mark-in" style={{ ["--i" as string]: i }} points={tri(x(mk.t), y(mk.changePct), 5.5)} fill={SELL} stroke={SELL_EDGE} strokeWidth="1.5" strokeLinejoin="round" />
          ))}
          {peak && last && !(peak.t === last.t && Math.abs(peak.changePct - last.changePct) < 0.05) && (
            <text
              x={Math.min(Math.max(x(peak.t), m.left + 40), m.left + iw - 40)}
              y={Math.max(y(peak.changePct) - 10, m.top + 10)}
              textAnchor="middle"
              fontSize="10.5"
              fill={INK}
              fontFamily={MONO}
              fontWeight="500"
              stroke={SURFACE}
              strokeWidth="3"
              paintOrder="stroke"
            >
              Peak {signed(peak.changePct)}
            </text>
          )}
          {last && (
            <>
              <rect className="mark-in" x={x(last.t) - 4} y={y(last.changePct) - 4} width="8" height="8" fill={INK} stroke={SURFACE} strokeWidth="2" />
              <text className="mark-in" x={x(last.t) + 9} y={y(last.changePct) + 4} fontSize="11" fill={INK} fontFamily={MONO} fontWeight="500">
                {signed(last.changePct)}
              </text>
            </>
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={x(hp.t)} x2={x(hp.t)} y1={m.top} y2={m.top + ih} stroke={INK} strokeWidth="1" opacity="0.4" strokeDasharray="3 3" />
              <circle cx={x(hp.t)} cy={y(hp.changePct)} r="4.5" fill={INK} stroke={SURFACE} strokeWidth="2" />
            </g>
          )}
        </svg>
        {hp && (
          <div className="chart-tip" style={{ left: tipLeft, top: 8 }} role="status">
            <div className="v">{signed(hp.changePct)}</div>
            <div className="muted tiny">vs pack entry · {timeUtc(hp.t)}</div>
            {near.slice(0, 4).map((mk, i) => (
              <div className="row" key={i}>
                {mk.kind === "pack_buy" ? (
                  <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill={BUY} /></svg>
                ) : (
                  <svg width="10" height="10"><polygon points={tri(5, 5, 4.5)} fill={SELL} stroke={SELL_EDGE} strokeWidth="1.2" /></svg>
                )}
                <span>
                  {mk.kind === "pack_buy" ? "Pack buy" : "Pack wallet sell"} · {Number(mk.solAmount).toFixed(3)} SOL · <span className="mono">{shortAddr(mk.wallet)}</span>
                </span>
              </div>
            ))}
            {near.length > 4 && <div className="tiny muted" style={{ marginTop: 3 }}>and {near.length - 4} more</div>}
          </div>
        )}
      </div>
      <details className="table-toggle">
        <summary>Show the chart data as a table</summary>
        <div className="table-wrap chart-table">
          <table className="table compact">
            <caption className="sr-only">Trade price versus pack entry over time, with pack buys and pack wallet sells</caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col" className="num">Vs pack entry</th>
                <th scope="col">Events</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p, i) => {
                const ev = markers.filter((mk) => Math.abs(mk.t - p.t) < 500);
                return (
                  <tr key={i}>
                    <td className="mono">{timeUtc(p.t)}</td>
                    <td className="num">{signed(p.changePct)}</td>
                    <td className="small">
                      {ev.length === 0 ? "" : `${ev.filter((e) => e.kind === "pack_buy").length ? `${ev.filter((e) => e.kind === "pack_buy").length} pack buy ` : ""}${ev.filter((e) => e.kind === "member_sell").length ? `${ev.filter((e) => e.kind === "member_sell").length} pack wallet sell` : ""}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
