import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import type { SourceStatus } from "@packlens/contracts";
import { EventsProvider } from "./api/events";
import { useApi } from "./api/hooks";
import { TopBar } from "./components/TopBar";
import { useNamespace } from "./state/namespace";
import { RadarPage } from "./pages/RadarPage";
import { PackDetailPage } from "./pages/PackDetailPage";
import { WalletPage } from "./pages/WalletPage";
import { TokenPage } from "./pages/TokenPage";
import { SmartMoneyPage } from "./pages/SmartMoneyPage";
import { OperatorPage } from "./pages/OperatorPage";
import { GuidePage } from "./pages/GuidePage";
import { NotFoundPage } from "./pages/NotFoundPage";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

function Shell() {
  const namespace = useNamespace();
  const status = useApi<SourceStatus>("/api/status", namespace ? { namespace } : {});
  useEffect(() => {
    const t = setInterval(status.reload, 15_000);
    return () => clearInterval(t);
  }, [status.reload]);
  return (
    <EventsProvider namespace={namespace}>
      <div className="ambient" aria-hidden="true" />
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <TopBar status={status.data} />
        <ScrollToTop />
        <main id="main" className="page">
          <Routes>
            <Route path="/" element={<RadarPage status={status.data} />} />
            <Route path="/packs/:id" element={<PackDetailPage />} />
            <Route path="/wallets/solana/:address" element={<WalletPage />} />
            <Route path="/tokens/solana/:mint" element={<TokenPage />} />
            <Route path="/smart-money" element={<SmartMoneyPage />} />
            <Route path="/operator" element={<OperatorPage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <footer className="footer">
          <div className="container">
            <span>
              PackLens · Detection: at least 3 unique wallets, $20 per eligible buy, within 20 seconds. Smart Money is context only.
            </span>
            <span>Research tool. Not trading advice. Times are shown in UTC.</span>
          </div>
        </footer>
      </div>
    </EventsProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
