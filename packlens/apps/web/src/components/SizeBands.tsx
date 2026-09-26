import type { OverviewData } from "@packlens/contracts";
import { int } from "../lib/format";

/**
 * Pack size in ordered bands: one series, horizontal bars from a shared
 * baseline, every value labeled at the bar tip (so no tooltip is needed to
 * read it).
 */
export function SizeBands({ bands, total }: { bands: OverviewData["sizeBands"]; total: number }) {
  const max = bands.reduce((a, b) => Math.max(a, b.packs), 0);
  return (
    <ul className="bands" aria-label="Packs by number of unique wallets">
      {bands.map((b) => {
        const share = total > 0 ? b.packs / total : 0;
        return (
          <li key={b.label}>
            <span className="band-label">
              {b.max === null ? `${b.min}+` : b.min === b.max ? b.min : `${b.min} to ${b.max}`}
              <span className="sr-only"> wallets</span>
            </span>
            <span className="band-track" aria-hidden="true">
              <span className="band-bar" style={{ width: `${max > 0 ? Math.max(b.packs > 0 ? 1.5 : 0, (b.packs / max) * 100) : 0}%` }} />
            </span>
            <span className="band-value">
              {int(b.packs)}
              <span className="muted"> · {total > 0 ? `${Math.round(share * 100)}%` : "n/a"}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
