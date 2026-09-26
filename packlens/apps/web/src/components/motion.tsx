import { useEffect, useRef, useState } from "react";

/** Blocks that lift into place the first time they scroll into view. */
const REVEAL = ".section, .feed-section, .overview, .technical-head, #sec-glance, .how";

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scroll reveal for page blocks. Elements are only hidden once this runs, so
 * without JavaScript or IntersectionObserver everything is simply visible.
 * New blocks (loaded data, route changes) are picked up before they paint.
 */
export function useScrollReveal(key: string): void {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined" || reducedMotion()) return;
    const main = document.getElementById("main");
    if (!main) return;
    document.documentElement.classList.add("motion");
    const io = new IntersectionObserver(
      (entries) => {
        let n = 0;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.style.setProperty("--reveal-i", String(n++));
          el.classList.add("is-in");
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.01 },
    );
    const watched = new WeakSet<Element>();
    const scan = () => {
      main.querySelectorAll<HTMLElement>(REVEAL).forEach((el) => {
        if (watched.has(el) || el.classList.contains("is-in")) return;
        watched.add(el);
        el.setAttribute("data-reveal", "");
        io.observe(el);
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(main, { childList: true, subtree: true });
    const showAll = () => main.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    window.addEventListener("beforeprint", showAll);
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("beforeprint", showAll);
    };
  }, [key]);
}

const DIGITS = "0123456789";

function scramble(text: string, keep: string | null): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out += /\d/.test(ch) && keep?.[i] !== ch ? DIGITS[Math.floor(Math.random() * 10)] : ch;
  }
  return out;
}

/**
 * A figure that settles like a split-flap readout: digits that changed flicker
 * briefly, left to right, then land on the real value. Letters and unchanged
 * digits never move. The final text is always exactly `text`.
 */
export function Decode({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = text;
    if (from === text || reducedMotion()) {
      setShown(text);
      return;
    }
    const start = performance.now();
    const total = Math.min(620, 260 + text.length * 40);
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      const settled = Math.floor((t / total) * (text.length + 1));
      if (settled >= text.length) {
        setShown(text);
        return;
      }
      setShown(text.slice(0, settled) + scramble(text.slice(settled), from?.slice(settled) ?? null));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // A re-run (for example React's development double effect) animates again.
      prev.current = from;
      setShown(text);
    };
  }, [text]);
  return <span className={className}>{shown}</span>;
}

/** Point on a circle, clockwise from 12 o'clock, in the 200 x 200 reticle space. */
function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
}

const SWEEP_S = 7;
/** Decorative echoes only; positions are fixed and carry no data. */
const ECHOES: [number, number][] = [
  [38, 62],
  [117, 34],
  [164, 80],
  [243, 52],
  [301, 70],
  [332, 28],
];

/**
 * A slow radar sweep for the radar header: fine rings, bearing ticks, and a
 * red sweep line. Purely decorative (hidden from assistive technology); the
 * caption states the detection windows it stands for.
 */
export function Reticle({ windowSeconds, joinSeconds }: { windowSeconds: number; joinSeconds: number }) {
  const [fx, fy] = polar(-42, 96);
  const [ix, iy] = polar(-16, 96);
  return (
    <div className="reticle" aria-hidden="true">
      <svg viewBox="0 0 200 200">
        <circle className="ring" cx="100" cy="100" r="96" />
        <circle className="ring faint" cx="100" cy="100" r="72" />
        <circle className="ring faint" cx="100" cy="100" r="48" />
        <circle className="ring faint" cx="100" cy="100" r="24" />
        <line className="axis-line" x1="100" y1="4" x2="100" y2="196" />
        <line className="axis-line" x1="4" y1="100" x2="196" y2="100" />
        {Array.from({ length: 72 }, (_, i) => {
          const deg = i * 5;
          const major = deg % 30 === 0;
          const [x1, y1] = polar(deg, 96);
          const [x2, y2] = polar(deg, major ? 88 : 92.5);
          return <line key={deg} className={`tick${major ? " major" : ""}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
        {[0, 90, 180, 270].map((deg) => {
          const [x, y] = polar(deg, 106);
          return (
            <text key={deg} className="bearing" x={x} y={y + 2.5} textAnchor="middle">
              {String(deg).padStart(3, "0")}
            </text>
          );
        })}
        {ECHOES.map(([deg, r]) => {
          const [x, y] = polar(deg, r);
          return <rect key={deg} className="node" x={x - 1.6} y={y - 1.6} width="3.2" height="3.2" style={{ animationDelay: `${(deg / 360) * SWEEP_S}s` }} />;
        })}
        <g className="sweep">
          <path className="sweep-fan" d={`M100,100 L${fx},${fy} A96,96 0 0,1 100,4 Z`} />
          <path className="sweep-fan inner" d={`M100,100 L${ix},${iy} A96,96 0 0,1 100,4 Z`} />
          <line className="sweep-line" x1="100" y1="100" x2="100" y2="4" />
        </g>
        <rect className="core" x="97.5" y="97.5" width="5" height="5" />
      </svg>
      <div className="reticle-cap">
        <span>Window {windowSeconds} s</span>
        <span>Join +{joinSeconds} s</span>
      </div>
    </div>
  );
}
