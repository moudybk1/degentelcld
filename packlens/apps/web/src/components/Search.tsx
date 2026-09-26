import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { SearchData } from "@packlens/contracts";
import { apiGet } from "../api/client";
import { relative, shortAddr } from "../lib/format";
import { useNamespace, useNsHref } from "../state/namespace";
import { TokenAvatar } from "./ui";

type Option = { key: string; to: string; title: string; sub: string; token?: SearchData["tokens"][number]["token"] };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Top bar search over tokens that have packs (name, symbol, or mint) and
 * wallets (exact address). A pasted address always offers direct links, even
 * when the server has no match, so nothing depends on the search index.
 */
export function Search() {
  const href = useNsHref();
  const namespace = useNamespace();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchData | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      apiGet<SearchData>("/api/search", { q: text, ...(namespace ? { namespace } : {}) }, ctrl.signal)
        .then((r) => setData(r.data))
        .catch(() => setData(null));
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, namespace]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const text = q.trim();
  const options: Option[] = [];
  for (const t of data?.tokens ?? []) {
    options.push({
      key: `t-${t.token.mint}`,
      to: href(`/tokens/solana/${t.token.mint}`),
      title: t.token.name || t.token.symbol || shortAddr(t.token.mint),
      sub: `${t.token.name && t.token.symbol ? `${t.token.symbol} · ` : ""}${t.packs} ${t.packs === 1 ? "pack" : "packs"} · latest ${relative(t.latestTriggerMs)}`,
      token: t.token,
    });
  }
  if (data?.wallet) options.push({ key: `w-${data.wallet.address}`, to: href(`/wallets/solana/${data.wallet.address}`), title: `Wallet ${shortAddr(data.wallet.address, 6, 6)}`, sub: `In ${data.wallet.packs} ${data.wallet.packs === 1 ? "pack" : "packs"}` });
  if (ADDRESS.test(text) && options.length === 0) {
    options.push({ key: "open-token", to: href(`/tokens/solana/${text}`), title: `Open ${shortAddr(text, 6, 6)} as a token`, sub: "No pack recorded for this address yet" });
    options.push({ key: "open-wallet", to: href(`/wallets/solana/${text}`), title: `Open ${shortAddr(text, 6, 6)} as a wallet`, sub: "No pack recorded for this address yet" });
  }
  const showList = open && text.length >= 2 && (options.length > 0 || data !== null);
  const go = (o: Option | undefined) => {
    if (!o) return;
    setOpen(false);
    setQ("");
    navigate(o.to);
  };

  return (
    <div className="search-box" ref={wrap}>
      <MagnifyingGlass size={15} weight="bold" aria-hidden="true" />
      <input
        type="search"
        className="input"
        placeholder="Search token, symbol, or wallet"
        aria-label="Search tokens and wallets"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && options[active] ? `${listId}-${active}` : undefined}
        value={q}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(options.length - 1, a + 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          else if (e.key === "Enter") go(options[active]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {showList && (
        <ul className="search-list" role="listbox" id={listId} aria-label="Search results">
          {options.length === 0 ? (
            <li className="search-empty" role="option" aria-selected="false" aria-disabled="true">
              No token with a pack matches “{text}”.
            </li>
          ) : (
            options.map((o, i) => (
              <li
                key={o.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "on" : ""}
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  go(o);
                }}
              >
                {o.token ? <TokenAvatar mint={o.token.mint} symbol={o.token.symbol} name={o.token.name} image={o.token.imageUrl} /> : <span className="search-glyph" aria-hidden="true" />}
                <span className="search-text">
                  <span className="search-title">{o.title}</span>
                  <span className="search-sub">{o.sub}</span>
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
