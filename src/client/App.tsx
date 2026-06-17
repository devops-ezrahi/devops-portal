import { RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getMe,
  ForbiddenError,
  UnauthenticatedError,
} from "./api";
import { AccessDeniedScreen } from "./AccessDeniedScreen";
import { ErrorScreen } from "./ErrorScreen";
import { LoginScreen } from "./LoginScreen";
import { argoCdModule } from "./modules/argocd";
import { artifactoryModule } from "./modules/artifactory";
import { branchDiffModule } from "./modules/branchdiff";
import { ragflowModule } from "./modules/ragflow";
import { ticketingModule } from "./modules/ticketing";
import type { PortalModule } from "./moduleTypes";
import type { PortalUser } from "../server/types";

const modules: PortalModule[] = [ticketingModule, artifactoryModule, ragflowModule, argoCdModule, branchDiffModule];

function slugFor(mod: PortalModule) {
  return mod.userNav.label.toLowerCase();
}

function moduleFromPath(pathname: string): string {
  const slug = pathname.replace(/^\//, "").toLowerCase();
  return modules.find((m) => slugFor(m) === slug)?.id ?? modules[0].id;
}

export function App() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [ssoUrl, setSsoUrl] = useState("");
  const [activeModuleId, setActiveModuleId] = useState(() => moduleFromPath(window.location.pathname));
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    function onPopState() {
      setActiveModuleId(moduleFromPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigateTo(id: string) {
    const mod = modules.find((m) => m.id === id);
    if (mod) window.history.pushState({}, "", `/${slugFor(mod)}`);
    setActiveModuleId(id);
  }

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    setLoadError(null);
    setForbidden(false);
    setUnauthenticated(false);
    getMe()
      .then(({ user: me, isAdmin: admin }) => {
        if (!mounted) return;
        setUser(me);
        setIsAdmin(admin);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!mounted) return;
        if (err instanceof UnauthenticatedError) {
          setUnauthenticated(true);
          setSsoUrl(err.ssoUrl);
        } else if (err instanceof ForbiddenError) {
          setForbidden(true);
        } else {
          setLoadError(err.message);
        }
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [retryKey]);

  const activeModule = modules.find((m) => m.id === activeModuleId) ?? modules[0];

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
      <header className="app-header">
        <div className="brand">DevOps</div>

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
        </nav>

        <div className="header-actions">
          <div className="user-box">
            <span>{user?.displayName ?? "Signed in user"}</span>
          </div>

          <button className="ghost-button" onClick={() => setRefreshKey((k) => k + 1)}>
            <RefreshCcw size={17} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

      <main className="main">
        {error && <div className="error-banner">{error}</div>}
        {loading ? (
          <div className="loading-state" aria-label="Loading" />
        ) : (
          <activeModule.View
            user={user!}
            isAdmin={isAdmin}
            refreshKey={refreshKey}
            onError={setError}
          />
        )}
      </main>
    </div>
  );
}
