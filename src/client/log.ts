// Developer-console instrumentation. On in dev; in prod turn it on per-browser
// with: localStorage.portalDebug = "1" (and "0"/remove to silence it).
// ponytail: window.fetch is wrapped once here instead of adding a log line to
// every module's api.ts — one choke point covers every request in the app.

const ON = import.meta.env.DEV || localStorage.getItem("portalDebug") === "1";
const BOOT = performance.now();

function since() {
  return `+${(performance.now() - BOOT).toFixed(0)}ms`;
}

function emit(fn: (...a: unknown[]) => void, color: string, scope: string, args: unknown[]) {
  if (!ON) return;
  fn(`%c${scope}%c ${since()}`, `color:${color};font-weight:700`, "color:#7a8b90", ...args);
}

export function log(scope: string, ...args: unknown[]) {
  emit(console.log, "#20c7bd", scope, args);
}

export function warn(scope: string, ...args: unknown[]) {
  emit(console.warn, "#e0a33e", scope, args);
}

export function error(scope: string, ...args: unknown[]) {
  emit(console.error, "#e0554e", scope, args);
}

function describeBody(body: BodyInit | null | undefined) {
  if (!body) return undefined;
  if (body instanceof FormData) {
    return Object.fromEntries(
      [...body.entries()].map(([k, v]) => [k, v instanceof File ? `File(${v.name}, ${v.size}b)` : String(v).slice(0, 120)])
    );
  }
  if (typeof body === "string") return body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return `[${body.constructor?.name ?? typeof body}]`;
}

export function installConsoleLogging() {
  if (!ON) return;

  log("boot", "portal starting", {
    url: window.location.href,
    mode: import.meta.env.MODE,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    userAgent: navigator.userAgent,
  });

  const original = window.fetch;
  let seq = 0;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = ++seq;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const started = performance.now();
    log(`net#${id} →`, method, url, describeBody(init?.body) ?? "");
    try {
      const res = await original(input, init);
      const ms = (performance.now() - started).toFixed(0);
      // ponytail: status + timing only — reading the body here would drain the
      // chat SSE stream before ChatView gets it.
      (res.ok ? log : error)(`net#${id} ←`, method, url, res.status, res.statusText, `${ms}ms`, {
        type: res.headers.get("content-type"),
      });
      return res;
    } catch (err) {
      error(`net#${id} ✗`, method, url, `${(performance.now() - started).toFixed(0)}ms`, err);
      throw err;
    }
  };

  window.addEventListener("error", (e) => error("window.error", e.message, `${e.filename}:${e.lineno}`, e.error));
  window.addEventListener("unhandledrejection", (e) => error("unhandled rejection", e.reason));
  window.addEventListener("online", () => log("network", "online"));
  window.addEventListener("offline", () => warn("network", "offline"));
  document.addEventListener("visibilitychange", () => log("page", `visibility: ${document.visibilityState}`));
}
