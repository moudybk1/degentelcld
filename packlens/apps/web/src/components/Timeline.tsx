import type { EvidenceMeta, Pack, PackMember, TradeEvent } from "@packlens/contracts";
import { shortAddr, timeUtc } from "../lib/format";

/**
 * Member swimlane timeline. Initial evidence is a filled circle, expansion
 * evidence a hollow diamond, so the distinction never relies on color alone.
 */
export function Timeline({ core, members, evidence, meta }: { core: Pack; members: PackMember[]; evidence: TradeEvent[]; meta: EvidenceMeta[] }) {
  const roleOf = new Map(meta.map((m) => [m.eventId, m.role]));
  const lastEvidence = Math.max(...evidence.map((e) => e.blockTimeMs), core.triggerEventTimeMs);
  const start = Math.min(core.firstEventTimeMs, core.triggerEventTimeMs - 20_000) - 2000;
  const end = Math.max(core.expansionEndMs, lastEvidence) + 3000;
  const W = 1000;
  const labelW = 150;
  // Large packs compress rows so the chart stays one screen tall; labels move to the member table.
  const compact = members.length > 24;
  const rowH = compact ? Math.max(6, Math.floor(620 / members.length)) : 26;
  const top = 34;
  const H = top + members.length * rowH + 30;
  const x = (t: number) => labelW + ((t - start) / (end - start)) * (W - labelW - 16);
  // Ticks are aligned to the first evidence time, labeled in whole seconds from it.
  const ticks: number[] = [];
  const step = end - start > 90_000 ? 20_000 : 10_000;
  for (let k = Math.ceil((start - core.firstEventTimeMs) / step); core.firstEventTimeMs + k * step <= end; k++) ticks.push(core.firstEventTimeMs + k * step);
  const tickLabel = (t: number) => `${Math.round((t - core.firstEventTimeMs) / 1000)}s`;
  const nearRight = (px: number) => px > W - 190;

  return (
    <figure className="timeline" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Timeline of ${evidence.length} evidence events across ${members.length} wallets. Trigger at ${timeUtc(core.triggerEventTimeMs)}, expansion ends at ${timeUtc(core.expansionEndMs)}.`}>
        {/* 20-second trigger window */}
        <rect x={x(core.triggerEventTimeMs - 20_000)} y={top - 14} width={x(core.triggerEventTimeMs) - x(core.triggerEventTimeMs - 20_000)} height={H - top - 2} fill="#F3F2EE" />
        {/* Expansion interval */}
        <rect x={x(core.triggerEventTimeMs)} y={top - 14} width={Math.max(0, x(core.expansionEndMs) - x(core.triggerEventTimeMs))} height={H - top - 2} fill="#FBF8EF" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top - 14} y2={H - 16} stroke="#EAEAEA" />
            <text x={x(t)} y={H - 2} textAnchor="middle" fontSize="11" fill="#9B9A97" fontFamily="var(--font-mono)">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        <line x1={x(core.triggerEventTimeMs)} x2={x(core.triggerEventTimeMs)} y1={top - 18} y2={H - 16} stroke="#111111" strokeWidth="1.5" />
        <text x={x(core.triggerEventTimeMs) + 5} y={top - 20} fontSize="11" fill="#111111">
          Trigger
        </text>
        <line x1={x(core.expansionEndMs)} x2={x(core.expansionEndMs)} y1={top - 18} y2={H - 16} stroke="#956400" strokeWidth="1.2" strokeDasharray="4 3" />
        <text x={nearRight(x(core.expansionEndMs)) ? x(core.expansionEndMs) - 5 : x(core.expansionEndMs) + 5} y={top - 20} fontSize="11" fill="#956400" textAnchor={nearRight(x(core.expansionEndMs)) ? "end" : "start"}>
          Expansion ends (+40 s)
        </text>
        <text x={x(core.triggerEventTimeMs - 20_000) + 5} y={top - 20} fontSize="11" fill="#787774">
          20 s window
        </text>
        {compact && (
          <text x={0} y={top + 12} fontSize="12" fill="#787774">
            <tspan x={0}>{members.length} wallets,</tspan>
            <tspan x={0} dy={16}>one row each</tspan>
          </text>
        )}
        {members.map((m, i) => {
          const y = top + i * rowH + rowH / 2;
          const evs = evidence.filter((e) => e.walletAddress === m.walletAddress);
          const r = compact ? Math.max(2.5, Math.min(6, rowH / 2 - 0.5)) : 6;
          return (
            <g key={m.walletAddress}>
              {!compact && (
                <text x={0} y={y + 4} fontSize="12" fill={m.memberKind === "initial" ? "#111111" : "#787774"} fontFamily="var(--font-mono)">
                  {shortAddr(m.walletAddress, 5, 4)}
                </text>
              )}
              {!compact && <line x1={labelW} x2={W - 16} y1={y} y2={y} stroke="#F1F1EF" />}
              {evs.map((e) => {
                const cx = x(e.blockTimeMs);
                const role = roleOf.get(e.eventId) ?? "initial";
                return role === "initial" ? (
                  <circle key={e.eventId} cx={cx} cy={y} r={r} fill="#111111">
                    <title>{`${timeUtc(e.blockTimeMs)} · initial evidence · ${e.tradeValueUsd ? `$${Number(e.tradeValueUsd).toFixed(2)}` : "unvalued"}`}</title>
                  </circle>
                ) : (
                  <rect key={e.eventId} x={cx - r + 1} y={y - r + 1} width={(r - 1) * 2} height={(r - 1) * 2} transform={`rotate(45 ${cx} ${y})`} fill="#FFFFFF" stroke="#956400" strokeWidth={compact ? 1.2 : 2}>
                    <title>{`${timeUtc(e.blockTimeMs)} · expansion evidence · ${e.tradeValueUsd ? `$${Number(e.tradeValueUsd).toFixed(2)}` : "unvalued"}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="legend" style={{ marginTop: 10 }}>
        <span>
          <i style={{ background: "#111111" }} />
          Initial evidence
        </span>
        <span>
          <i style={{ background: "#FFFFFF", boxShadow: "inset 0 0 0 2px #956400", borderRadius: 2, transform: "rotate(45deg)" }} />
          Expansion evidence
        </span>
        <span>
          <i style={{ background: "#F3F2EE", borderRadius: 2 }} />
          Trigger window (20 s)
        </span>
        <span>
          <i style={{ background: "#FBF8EF", borderRadius: 2 }} />
          Expansion interval (until 40 s from first evidence)
        </span>
        <span>Axis: seconds from first evidence.</span>
      </figcaption>
    </figure>
  );
}
