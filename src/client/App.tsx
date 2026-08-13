import { RefreshCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  getMe,
  setDevRole,
  ForbiddenError,
  UnauthenticatedError,
} from "./api";
import { log, warn, error as logError } from "./log";
import { AccessDeniedScreen } from "./AccessDeniedScreen";
import { ErrorScreen } from "./ErrorScreen";
import { LoginScreen } from "./LoginScreen";
import { artifactoryModule } from "./modules/artifactory";
import { aiModule } from "./modules/ai";
import { ticketingModule } from "./modules/ticketing";
import { whiteningModule } from "./modules/whitening";
import type { PortalModule } from "./moduleTypes";
import type { PortalUser } from "../server/types";
// Inlined at bundle time and tree-shaken to the one string, so the running
// build identifies itself with no endpoint, no fetch and no state. CI bumps
// package.json before `docker build`, so this is the released version.
import { version } from "../../package.json";

const modules: PortalModule[] = [ticketingModule, artifactoryModule, whiteningModule, aiModule];

function slugFor(mod: PortalModule) {
  return mod.userNav.label.toLowerCase();
}

function moduleFromPath(pathname: string): string {
  const slug = pathname.replace(/^\//, "").split("/")[0].toLowerCase();
  return modules.find((m) => slugFor(m) === slug)?.id ?? modules[0].id;
}

// Stella easter eggs. She's a cat. Not load-bearing.

export function App() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // Keyed by module id: modules stay mounted, so one shell-wide banner would
  // follow you into every other tab and never clear.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [ssoUrl, setSsoUrl] = useState("");
  const [activeModuleId, setActiveModuleId] = useState(() => moduleFromPath(window.location.pathname));
  // Modules mount on first visit and are hidden — never unmounted — afterwards, so
  // a running upload keeps its progress bar, selection and poll across tab switches.
  const [visited, setVisited] = useState<string[]>([activeModuleId]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stellaPop, setStellaPop] = useState(false);
  const [stellaWalks, setStellaWalks] = useState(false);
  const brandClicks = useRef(0);

  // 1-in-100 per page load / tab switch / refresh, she strolls through the header.
  useEffect(() => {
    // ponytail: ?stella forces the walk so it's testable without 100 reloads
    if (stellaWalks || (!window.location.search.includes("stella") && Math.random() >= 0.01)) return;
    setStellaWalks(true);
    setTimeout(() => setStellaWalks(false), 9000);
  }, [activeModuleId, refreshKey]);

  useEffect(() => {
    log("app", "shell mounted", { modules: modules.map((m) => m.id), initialModule: activeModuleId });
    function onPopState() {
      const next = moduleFromPath(window.location.pathname);
      log("router", "popstate", window.location.pathname, "→", next);
      setActiveModuleId(next);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigateTo(id: string) {
    const mod = modules.find((m) => m.id === id);
    log("router", "navigate", activeModuleId, "→", id, mod ? `/${slugFor(mod)}` : "(unknown module)");
    if (mod) window.history.pushState({}, "", `/${slugFor(mod)}`);
    setActiveModuleId(id);
  }

  useEffect(() => {
    let mounted = true;
    log("auth", "loading /api/me", { retryKey });
    setLoading(true);
    setErrors({});
    setLoadError(null);
    setForbidden(false);
    setUnauthenticated(false);
    getMe()
      .then(({ user: me, isAdmin: admin }) => {
        if (!mounted) return log("auth", "ignoring /api/me result — unmounted");
        log("auth", "signed in", { id: me.id, displayName: me.displayName, groups: me.groups, isAdmin: admin });
        setUser(me);
        setIsAdmin(admin);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!mounted) return;
        if (err instanceof UnauthenticatedError) {
          warn("auth", "unauthenticated — showing login screen", { ssoUrl: err.ssoUrl });
          setUnauthenticated(true);
          setSsoUrl(err.ssoUrl);
        } else if (err instanceof ForbiddenError) {
          warn("auth", "forbidden — user is not in ALLOWED_GROUPS", err.message);
          setForbidden(true);
        } else {
          logError("auth", "/api/me failed", err);
          setLoadError(err.message);
        }
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [retryKey]);

  const activeModule = modules.find((m) => m.id === activeModuleId) ?? modules[0];

  useEffect(() => {
    setVisited((v) => (v.includes(activeModule.id) ? v : [...v, activeModule.id]));
  }, [activeModule.id]);

  // Refresh clears stale banners along with the data behind them.
  useEffect(() => setErrors({}), [refreshKey]);

  useEffect(() => {
    log("app", "rendering module", activeModule.id, { isAdmin, refreshKey });
  }, [activeModule.id, isAdmin, refreshKey]);

  if (forbidden) {
    return <AccessDeniedScreen />;
  }

  if (loadError) {
    return <ErrorScreen message={loadError} onRetry={() => setRetryKey((k) => k + 1)} />;
  }

  if (unauthenticated) {
    return <LoginScreen ssoUrl={ssoUrl} />;
  }

  return (
    <div className="app-shell">
      {user?.id === "dev" && (
        <div className="dev-banner" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <span>
            Dev mode — SSO is off.{" "}
            <a href="https://portal.devops-ezrahi.duckdns.org" className="dev-banner-link">
              Open portal.devops-ezrahi.duckdns.org
            </a>{" "}
            to log in as a real user.
          </span>
          <div className="role-toggle">
            <button
              className={!isAdmin ? "active" : ""}
              onClick={() => {
                log("dev", "switching role → user");
                setDevRole("user").then(() => setRetryKey((k) => k + 1));
              }}
            >User</button>
            <button
              className={isAdmin ? "active" : ""}
              onClick={() => {
                log("dev", "switching role → admin");
                setDevRole("admin").then(() => setRetryKey((k) => k + 1));
              }}
            >Admin</button>
          </div>
        </div>
      )}
      <header className="app-header">
        <div
          className="brand"
          onClick={() => {
            brandClicks.current += 1;
            if (brandClicks.current < 15) return;
            brandClicks.current = 0;
            setStellaPop(true);
            setTimeout(() => setStellaPop(false), 3000);
          }}
        >
          DevOps
          <span className="brand-version">v{version}</span>
          {stellaPop && (
            <div className="stella-pop">
              <img src="/stella-1.png" alt="" />
            </div>
          )}
        </div>

        <nav className="app-nav" aria-label="Primary navigation">
          {modules.map((mod) => {
            const nav = isAdmin ? mod.adminNav : mod.userNav;
            return (
              <button
                key={mod.id}
                className={`nav-button${activeModuleId === mod.id ? " active" : ""}`}
                onClick={() => navigateTo(mod.id)}
              >
                <nav.Icon aria-hidden="true" />
                {nav.label}
              </button>
            );
          })}
          <div className="stella-lane">
            {stellaWalks && <img src="/stella-3.png" alt="" />}
          </div>
        </nav>

        <div className="header-actions">
          <div className="user-box">
            <span>{user?.displayName ?? "Signed in user"}</span>
          </div>

          <button
            className="ghost-button"
            onClick={() => {
              log("app", "refresh clicked — remounting", activeModuleId, `refreshKey ${refreshKey} → ${refreshKey + 1}`);
              setRefreshKey((k) => k + 1);
            }}
          >
            <RefreshCcw size={17} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <main className="main">
        {loading ? (
          <div className="loading-state" aria-label="Loading" />
        ) : (
          modules
            .filter((mod) => visited.includes(mod.id))
            .map((mod) => (
              <div key={mod.id} className="module-slot" hidden={mod.id !== activeModule.id}>
                {errors[mod.id] && <div className="error-banner">{errors[mod.id]}</div>}
                <mod.View
                  user={user!}
                  isAdmin={isAdmin}
                  refreshKey={refreshKey}
                  onError={(message) => {
                    logError(mod.id, "error banner", message);
                    setErrors((prev) => ({ ...prev, [mod.id]: message }));
                  }}
                />
              </div>
            ))
        )}
      </main>
    </div>
  );
}
