import { RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getDemoUserRole,
  getMe,
  getPortalConfig,
  setDemoUserRole,
  UnauthenticatedError,
} from "./api";
import type { DemoUserRole, PortalConfig } from "./api";
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
  const [demoRole, setDemoRole] = useState<DemoUserRole>(() => getDemoUserRole());
  const [portalConfig, setPortalConfig] = useState<PortalConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState<{ ssoUrl: string } | null>(null);
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
    getPortalConfig().then(setPortalConfig).catch(() => null);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    setUnauthenticated(null);
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
          setUnauthenticated({ ssoUrl: err.ssoUrl });
        } else {
          setError(err.message);
        }
        setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [demoRole]);

  function changeDemoRole(role: DemoUserRole) {
    setDemoUserRole(role);
    setDemoRole(role);
  }

  const activeModule = modules.find((m) => m.id === activeModuleId) ?? modules[0];
  const showDemoSwitcher = !portalConfig?.ssoRequired;

  if (unauthenticated) {
    return (
      <div className="app-shell">
        <div className="loading-state" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem", justifyContent: "center", height: "100vh" }}>
          <p>You must be signed in to use this portal.</p>
          {unauthenticated.ssoUrl ? (
            <a href={unauthenticated.ssoUrl} className="primary" style={{ padding: "0.5rem 1.5rem", borderRadius: "6px", textDecoration: "none" }}>
              Sign in with SSO
            </a>
          ) : (
            <p style={{ opacity: 0.6 }}>Contact your administrator for access.</p>
          )}
        </div>
      </div>
    );
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

          {showDemoSwitcher && (
            <div className="demo-switch" aria-label="Demo user switcher">
              <div className="role-toggle">
                <button
                  className={demoRole === "regular" ? "active" : ""}
                  onClick={() => changeDemoRole("regular")}
                >
                  Regular
                </button>
                <button
                  className={demoRole === "admin" ? "active" : ""}
                  onClick={() => changeDemoRole("admin")}
                >
                  Admin
                </button>
              </div>
            </div>
          )}

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
