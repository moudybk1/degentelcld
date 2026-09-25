import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Info } from "@phosphor-icons/react";
import { GLOSSARY, type GlossaryKey } from "../lib/glossary";

/**
 * Accessible explanation next to a number: opens on hover, keyboard focus, or
 * tap; closes on Escape or outside tap. The text is also reachable on the
 * Guide page, so the tip never gates information.
 */
export function InfoTip({ k, text, label }: { k?: GlossaryKey; text?: string; label?: string }) {
  const entry = k ? GLOSSARY[k] : null;
  const body = text ?? entry?.text ?? "";
  const name = label ?? entry?.term ?? "this value";
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  const pop = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !pop.current) return;
    setShift(0);
    const r = pop.current.getBoundingClientRect();
    const pad = 12;
    if (r.left < pad) setShift(pad - r.left);
    else if (r.right > window.innerWidth - pad) setShift(window.innerWidth - pad - r.right);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span className="infotip" ref={wrap} onMouseEnter={() => setOpen(true)} onMouseLeave={() => !pinned && setOpen(false)}>
      <button
        type="button"
        className="infotip-btn"
        aria-label={`What is ${name}?`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
          setOpen((o) => (pinned ? !o : true));
        }}
      >
        <Info size={13} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <span className="infotip-pop" role="tooltip" id={id} ref={pop} style={{ ["--shift" as string]: `${shift}px` }}>
          <strong>{name}</strong>
          <span>{body}</span>
        </span>
      )}
    </span>
  );
}
