import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./landing/LandingPage";
import { ROOT_FILE_COUNT } from "./data";

// kick off the demo chunk immediately on /demo deep links — don't wait for
// router render (§16)
const demoImport = (): Promise<typeof import("./demo/DemoPage")> => import("./demo/DemoPage");
if (typeof window !== "undefined" && window.location.pathname.startsWith("/demo")) {
  void demoImport();
}
const DemoPage = lazy(demoImport);

/** demo shell chrome as the Suspense fallback (§16) */
function DemoShellFallback(): JSX.Element {
  return (
    <div className="demo">
      <header className="topbar">
        <div className="topbar__row topbar__row--brand">
          <span className="wordmark">sayre_</span>
          <span className="topbar__repo">acme/monorepo</span>
          <span className="topbar__meta">main · {ROOT_FILE_COUNT.toLocaleString("en-US")} files · synced 2m ago</span>
          <div className="topbar__right">
            <span className="btn btn--primary btn--small">get early access</span>
          </div>
        </div>
        <div className="topbar__row topbar__row--tabs" aria-hidden="true">
          <div className="topbar__tabs">
            <span className="topbar__tab is-active">
              <span className="topbar__tab-dot" />
              filetree
            </span>
            <span className="topbar__tab">features</span>
            <span className="topbar__tab">relations</span>
          </div>
        </div>
      </header>
      <div className="demo__body">
        <main className="demo__canvas-area">
          <div className="statusline">
            <span className="statusline__text">loading acme/monorepo…</span>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/demo"
        element={
          <Suspense fallback={<DemoShellFallback />}>
            <DemoPage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
