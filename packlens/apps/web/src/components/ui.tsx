import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Check, Copy, Info, WarningCircle } from "@phosphor-icons/react";
import type { Mode } from "@packlens/contracts";
import { shortAddr } from "../lib/format";
import { avatarTone } from "../lib/explorer";

export type Tone = "gray" | "red" | "blue" | "green" | "yellow" | "outline";

/** Router state for breadcrumbs: the page the reader came from. */
export type FromState = { from?: { label: string; href: string } };

export function Tag({ tone = "gray", children, dot, pulse, title, className }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; title?: string; className?: string }) {
  return (
    <span className={`tag ${tone}${className ? ` ${className}` : ""}`} title={title}>
      {dot && <span className={`dot${pulse ? " pulse" : ""}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: Mode | null | undefined }) {
  if (!mode) return null;
  if (mode === "live") return <Tag tone="green" className="live" dot title="Live data from the pump.fun stream and Nansen">Live</Tag>;
  if (mode === "replay") return <Tag tone="yellow" dot title="Replay of a recorded dataset with its original times">Replay</Tag>;
  return <Tag tone="blue" dot title="Synthetic fixture data for offline use; not market observations">Example</Tag>;
}

/** Fade-up entry on scroll into view (IntersectionObserver, transform/opacity only). */
export function Reveal({ children, index = 0, as = "div", className = "", style }: { children: ReactNode; index?: number; as?: "div" | "section" | "li"; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -40px 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const Tag = as as "div";
  return (
    <Tag ref={ref as React.Ref<HTMLDivElement>} className={`reveal${inView ? " in" : ""} ${className}`} style={{ ...style, ["--index" as string]: Math.min(index, 8) }}>
      {children}
    </Tag>
  );
}

export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ display: "block", width, height, ...style }} aria-hidden="true" />;
}

export function LoadingBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="card" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="stack" style={{ gap: 10 }}>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} width={`${90 - i * 18}%`} />
        ))}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <p className="h3">{title}</p>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Note({ tone, children, icon = "info" }: { tone?: "yellow" | "red" | "blue"; children: ReactNode; icon?: "info" | "warn" }) {
  return (
    <div className={`note${tone ? ` ${tone}` : ""}`}>
      {icon === "warn" ? <WarningCircle size={16} weight="bold" aria-hidden="true" /> : <Info size={16} weight="bold" aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />}
    </button>
  );
}

/** Short address with a full-address copy control and an optional explorer link. In-app links navigate without a page reload and can carry where the reader came from. */
export function Address({ value, href, external, head = 4, tail = 4, copyLabel = "Copy full address", state }: { value: string; href?: string | null; external?: string | null; head?: number; tail?: number; copyLabel?: string; state?: FromState }) {
  const short = shortAddr(value, head, tail);
  return (
    <span className="addr" title={value}>
      {href ? href.startsWith("/") ? <Link to={href} state={state}>{short}</Link> : <a href={href}>{short}</a> : <span>{short}</span>}
      <CopyButton value={value} label={copyLabel} />
      {external && (
        <a className="icon-btn" href={external} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer (new tab)" title="Open in explorer">
          <ArrowUpRight size={13} weight="bold" />
        </a>
      )}
    </span>
  );
}

export function ExtLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="ext-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={12} weight="bold" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** Token logo when one is stored; otherwise (or if it fails to load) a monogram in a stable tone. */
export function TokenAvatar({ mint, symbol, name, image, large }: { mint: string; symbol: string | null; name: string | null; image?: string | null; large?: boolean }) {
  const tone = avatarTone(mint);
  const letter = (symbol ?? name ?? mint).replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?";
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!image && failed !== image;
  return (
    <span className={`token-avatar${large ? " lg" : ""}${showImage ? " has-img" : ""}`} style={{ background: tone.bg, color: tone.fg }} aria-hidden="true">
      {showImage ? <img src={image} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(image)} /> : letter}
    </span>
  );
}

export function Stat({ label, value, note, serif }: { label: ReactNode; value: ReactNode; note?: ReactNode; serif?: boolean }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${serif ? " serif" : ""}`}>{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

/** Show the first rows of a long table with an explicit control to reveal the rest. */
export function useRowLimit<T>(rows: T[], limit = 25): { visible: T[]; hidden: number; toggle: ReactNode } {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, rows.length - limit);
  const toggle =
    rows.length > limit ? (
      <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
        <button type="button" className="btn sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? `Show the first ${limit}` : `Show all ${rows.length} rows (${rows.length - limit} more)`}
        </button>
      </div>
    ) : null;
  return { visible: all ? rows : rows.slice(0, limit), hidden, toggle };
}

export function ErrorNote({ error, what }: { error: { message: string; code?: string } | null; what: string }) {
  if (!error) return null;
  return (
    <Note tone="red" icon="warn">
      <strong>{what} could not be loaded.</strong> {error.message}
    </Note>
  );
}
