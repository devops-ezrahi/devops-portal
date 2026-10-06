import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { redactSecrets } from "./redact";

declare global {
  namespace Express {
    interface Request {
      /** Short correlation id — echoed as X-Request-Id and in every error body. */
      id?: string;
    }
  }
}

// ponytail: console + a format function, not pino/winston. Container stdout is
// already the log sink; a library would only add a dependency and JSON nobody
// reads with `kubectl logs`.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel as Level] ?? LEVELS.info;

/** A request slower than this is worth a line even when it is a routine poll. */
const SLOW_MS = 1000;

function fields(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  return Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return ` ${k}=${/\s/.test(text ?? "") ? JSON.stringify(text) : text}`;
    })
    .join("");
}

// Redaction happens here rather than at call sites: url-copy fetches
// user-supplied URLs that can carry `user:pass@`, and every log line in the app
// passes through this one function.
// Everything on stdout, including errors: stdout and stderr are two separately
// buffered pipes, and a pod log that mixes them loses the ordering between a
// warning and the line that explains it. The level is in the text anyway.
function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${fields(extra)}`;
  console.log(redactSecrets(line));
}

export const log = {
  debug: (scope: string, message: string, extra?: Record<string, unknown>) => emit("debug", scope, message, extra),
  info: (scope: string, message: string, extra?: Record<string, unknown>) => emit("info", scope, message, extra),
  warn: (scope: string, message: string, extra?: Record<string, unknown>) => emit("warn", scope, message, extra),
  /**
   * Errors print the whole `.cause` chain plus the stack. Node's fetch() throws
   * a bare "fetch failed" TypeError and buries the real reason (ECONNREFUSED,
   * ENOTFOUND, self-signed certificate) one or two causes down — without the
   * walk the pod log says nothing at all about why a call didn't work.
   */
  error: (scope: string, message: string, err?: unknown, extra?: Record<string, unknown>) => {
    emit("error", scope, err === undefined ? message : `${message}: ${describeError(err)}`, extra);
    const stack = err instanceof Error ? err.stack : undefined;
    if (stack && threshold <= LEVELS.error) console.log(redactSecrets(stack));
  },
};

/** `TypeError: fetch failed <- caused by Error: connect ECONNREFUSED (ECONNREFUSED)`. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    chain.push(`${current.name}: ${current.message}${code ? ` (${code})` : ""}`);
    current = current.cause;
  }
  return chain.join(" <- caused by ");
}

/**
 * The same information as `describeError`, phrased for the person reading it in
 * the UI: `fetch failed (getaddrinfo ENOTFOUND artifactory.example.com)` rather
 * than a bare "fetch failed". Error class names are dropped — the cause is the
 * part that says what actually went wrong.
 */
export function userMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const causes: string[] = [];
  const seen = new Set<unknown>([err]);
  let current: unknown = err.cause;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    causes.push(current.message);
    current = current.cause;
  }
  return causes.length ? `${err.message} (${causes.join(": ")})` : err.message;
}

/**
 * One line per request, logged on `finish` so it carries the status and the
 * duration. Successful GETs are debug-only: the job lists and ticket lists poll
 * every 2-8s per open tab, and at info they bury everything that matters.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  req.id = randomUUID().slice(0, 8);
  res.setHeader("X-Request-Id", req.id);
  const started = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - started;
    const extra = {
      id: req.id,
      user: req.user?.id ?? "-",
      ms,
      // Present on uploads, which is exactly when the size is the interesting part.
      in: req.headers["content-length"],
    };
    const message = `${req.method} ${req.originalUrl} ${res.statusCode}`;
    if (res.statusCode >= 500) log.warn("http", message, extra);
    else if (res.statusCode >= 400) log.info("http", message, extra);
    else if (req.method === "GET" && ms < SLOW_MS) log.debug("http", message, extra);
    else log.info("http", message, extra);
  });

  next();
}

/**
 * Last-ditch handlers: without them a crashed pod restarts with an empty log
 * and the reason is gone. Both entrypoints install these.
 */
export function installProcessLogging() {
  process.on("uncaughtException", (err) => {
    log.error("process", "uncaught exception — exiting", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandled promise rejection", reason);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log.info("process", `${signal} received — shutting down`);
      process.exit(0);
    });
  }
}
