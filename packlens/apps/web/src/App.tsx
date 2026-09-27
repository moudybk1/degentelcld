import { useEffect } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router";
import type { SourceStatus } from "@packlens/contracts";
import { EventsProvider } from "./api/events";
import { useApi } from "./api/hooks";
import { TopBar } from "./components/TopBar";
import { useScrollReveal } from "./components/motion";
import { useNamespace, useNsHref } from "./state/namespace";
import { INITIAL_RULE, RuleProvider, ruleSentence } from "./lib/rule";
import { RadarPage } from "./pages/RadarPage";
import { PackDetailPage } from "./pages/PackDetailPage";
import { WalletPage } from "./pages/WalletPage";
import { RepeatWalletsPage } from "./pages/RepeatWalletsPage";
import { TokenPage } from "./pages/TokenPage";
import { SmartMoneyPage } from "./pages/SmartMoneyPage";
import { OperatorPage } from "./pages/OperatorPage";
import { GuidePage } from "./pages/GuidePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import symbolUrl from "./assets/brand/symbol-red-160.png";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

/** Brand lines on a slow ticker tape. Decorative; the same words are not data. */
const TICKER = ["Follow the evidence", "See the pattern", "Inspect the evidence", "Make your own call", "A pattern is the beginning", "Solana wallet intelligence"];

function Ticker() {
  const run = [...TICKER, ...TICKER];
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {[0, 1].map((copy) => (
          <div key={copy} style={{ display: "flex" }}>
            {run.map((t, i) => (
              <span className="ticker-item" key={`${copy}-${i}`}>
                {t}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Shell() {
  const namespace = useNamespace();
  const href = useNsHref();
  const { pathname } = useLocation();
  const status = useApi<SourceStatus>("/api/status", namespace ? { namespace } : {});
  useEffect(() => {
    const t = setInterval(status.reload, 15_000);
    return () => clearInterval(t);
  }, [status.reload]);
  useScrollReveal(pathname);
  const rule = status.data?.detector ?? INITIAL_RULE;
  return (
    <RuleProvider value={rule}>
    <EventsProvider namespace={namespace}>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <TopBar status={status.data} />
        <ScrollToTop />
        <main id="main" className="page">
          <div className="route" key={pathname}>
            <Routes>
              <Route path="/" element={<RadarPage status={status.data} />} />
              <Route path="/packs/:id" element={<PackDetailPage />} />
              <Route path="/wallets" element={<RepeatWalletsPage />} />
              <Route path="/wallets/solana/:address" element={<WalletPage />} />
              <Route path="/tokens/solana/:mint" element={<TokenPage />} />
              <Route path="/smart-money" element={<SmartMoneyPage />} />
              <Route path="/operator" element={<OperatorPage />} />
              <Route path="/guide" element={<GuidePage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </div>
        </main>
        <Ticker />
        <footer className="footer">
          <div className="container">
            <p className="footer-slogan" aria-hidden="true">
              Follow the evidence<span>.</span>
            </p>
            <div className="footer-grid">
              <div className="footer-brand">
                <img src={symbolUrl} width={36} height={36} alt="" />
                <div>
                  <span className="brand-name">Degentellegence</span>
                  <span className="tagline">Follow the evidence.</span>
                </div>
              </div>
              <div className="footer-meta">
                <span>Detection: {ruleSentence(rule)}. Smart Money is context only.</span>
                <span>Research tool. Not trading advice. Times are shown in UTC.</span>
              </div>
              <div className="footer-links">
                <NavLink to={href("/guide")}>Guide</NavLink>
                <NavLink to={href("/operator")}>Operator</NavLink>
              </div>
            </div>
            <div className="footer-rev" aria-hidden="true">
              <span>Solana · pump.fun · Nansen</span>
              <span>Unit / DGT-01</span>
            </div>
          </div>
        </footer>
      </div>
    </EventsProvider>
    </RuleProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
