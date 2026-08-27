import { execFile, spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { discoverPackages } from "./npmPackages";
import type { DiscoveredPackage } from "./npmPackages";

const execFileAsync = promisify(execFile);

/**
 * npm is `npm.cmd` on Windows, and Node 20.12+ refuses to spawn a bare `.cmd`
 * without a shell (CVE-2024-27980). Prod is Linux, but dev here is not always.
 */
const useShell = process.platform === "win32";

/**
 * Optional dependencies are platform-gated, so a single install resolves only
 * for whatever platform the pod happens to run on. Two passes cover what people
 * actually consume off Artifactory. A constant rather than an env var: mirroring
 * the runtime tree is a correctness property of the feature, not a per-deployment
 * knob, and one more ConfigMap key is one more thing to get silently wrong.
 * Adding arm64 is one more entry here.
 */
const DEP_PLATFORMS = [
  { os: "linux", cpu: "x64" },
  { os: "win32", cpu: "x64" },
] as const;

/**
 * Past this, the job falls back to copying the single artifact. The real cost is
 * not the download — `packPackage` does a full `cp` plus a `tar` per package, so
 * peak disk is roughly 4-5x the tree, and that lands on the node's ephemeral
 * storage (createTmpDir uses os.tmpdir(), not the PVC), which k8s evicts on.
 */
export const MAX_DEPENDENCY_PACKAGES = 800;

/**
 * Per platform pass, on top of the job's own AbortSignal. That signal only fires
 * when a human presses Stop — without a deadline a wedged registry pins an
 * in-progress job, its temp dir and the pod's disk indefinitely.
 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * `--loglevel=http` emits one line per registry request — ~150 of them for a
 * 65-package tree, all but identical, and the package table under the log
 * already says what resolved. They are counted rather than mirrored, so the
 * heartbeat below can report real progress without burying the lines that
 * actually diagnose a failure. Everything npm says that is *not* routine
 * progress (warnings, errors, the `added N packages` summary) is mirrored.
 */
const NPM_PROGRESS_RE = /^npm (?:http|timing|sill|verb) /;

/** Even non-routine npm output is capped: the log is persisted and re-polled. */
const MAX_NPM_LOG_LINES = 300;
const HEARTBEAT_MS = 15_000;

/**
 * The npm registry a tarball URL was served from. npm's registry layout is
 * `<registry>/<name>/-/<basename>-<version>.tgz`, where `<name>` is one segment
 * unscoped (`arg`) or two scoped (`@babel/core`) — so the registry is everything
 * above the `/-/` marker, minus those name segments.
 *
 *   https://registry.npmjs.org/arg/-/arg-4.1.5.tgz
 *     -> https://registry.npmjs.org
 *   https://af.example.com/artifactory/api/npm/npm-remote/@babel/core/-/core-7.0.0.tgz
 *     -> https://af.example.com/artifactory/api/npm/npm-remote
 *
 * `null` for anything not in that shape — a GitHub release tarball, a plain file
 * server. The caller then skips the dependency step rather than falling back to
 * registry.npmjs.org, because in a closed network that guess only buys a timeout,
 * and in an open one it silently resolves against a registry the user did not ask
 * for.
 */
export function npmRegistryFromUrl(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // lastIndexOf, so a registry whose own base path happens to contain a bare `-`
  // segment cannot shadow the real marker.
  const dash = segments.lastIndexOf("-");
  // The marker is always second-to-last: `.../-/<file>.tgz`.
  if (dash < 1 || dash !== segments.length - 2) return null;

  // A scope can only ever be the first of the two name segments.
  const nameSegments = dash >= 2 && segments[dash - 2].startsWith("@") ? 2 : 1;
  const base = segments.slice(0, dash - nameSegments);
  return base.length > 0 ? `${url.origin}/${base.join("/")}` : url.origin;
}

/**
 * npm keys per-registry credentials by the registry URI minus its protocol, with
 * a trailing slash: `//host/path/:_authToken=...`. Getting the trailing slash
 * wrong is the usual reason a token is silently ignored.
 */
export function npmAuthKey(registry: string): string {
  const url = new URL(registry);
  return `//${url.host}${url.pathname.replace(/\/+$/, "")}/`;
}

/** The throwaway `.npmrc` for one install prefix. */
export function npmrcContents(registry: string, token: string): string {
  const lines = [`registry=${registry}`];
  if (token) lines.push(`${npmAuthKey(registry)}:_authToken=${token}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Credential for the *source* registry. The common case needs no new config: an
 * Artifactory npm remote proxying npmjs, copied into a local repo on the same
 * instance, is the same host as ARTIFACTORY_URL and takes the same token.
 * Anything else falls to NPM_SOURCE_TOKEN, then to anonymous.
 */
export function sourceTokenFor(
  registry: string,
  artifactoryUrl: string,
  artifactoryToken: string,
  sourceToken: string
): string {
  if (artifactoryUrl && artifactoryToken) {
    try {
      if (new URL(registry).host === new URL(artifactoryUrl).host) return artifactoryToken;
    } catch {
      // Unparseable ARTIFACTORY_URL — fall through to the explicit token.
    }
  }
  return sourceToken;
}

/**
 * npm gained `--os` / `--cpu` in 9.7.0. Older npm accepts unknown CLI config keys
 * *silently* — `npm --zzz=1 config get zzz` prints `1` on 9.2.0 with no warning —
 * so there is nothing on stderr to detect this by, and a naive implementation
 * would quietly resolve only the native platform. The version is the only signal.
 *
 * Numeric compare, not string: "9.10.0" has to beat "9.7.0".
 */
export function supportsPlatformFlags(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 9 || (major === 9 && minor >= 7);
}

/** npm's own package-name grammar. */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** An exact version off a manifest — never a range, so no spaces or operators. */
const NPM_VERSION_RE = /^[0-9A-Za-z.+-]+$/;

/**
 * `name@version`, or `null` for anything we refuse to hand to a subprocess.
 * The name comes out of `package/package.json` inside a tarball fetched from a
 * user-supplied URL, so it is attacker-controlled: unvalidated it reaches both an
 * `npm install` argv and (via targetPath) a repo path a `../` could escape.
 */
export function packageSpec(name: string, version: string): string | null {
  if (name.length === 0 || name.length > 214) return null;
  if (!NPM_NAME_RE.test(name) || !NPM_VERSION_RE.test(version)) return null;
  return `${name}@${version}`;
}

type Platform = (typeof DEP_PLATFORMS)[number];

/**
 * One `npm install` pass, streaming its output into the job log as it arrives.
 *
 * spawn, not execFileAsync: an install runs for minutes and execFile buffers
 * until exit, so the job drawer would sit blank for the whole thing and only
 * fill in once it was already over. Same reason RealAiApi spawns opencode.
 */
function runNpmInstall(opts: {
  spec: string;
  prefix: string;
  cacheDir: string;
  registry: string;
  platform: Platform | null;
  onLog: (line: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { spec, prefix, cacheDir, registry, platform, onLog, signal } = opts;

  const args = [
    "install",
    spec,
    // No-op for a transitive tree (npm only installs devDeps of the root, and
    // our root is a stub) — kept because it documents what the tree is meant to
    // be, and insures against the root stub ever growing dependencies.
    "--omit=dev",
    // A downloaded package's install script would run as the portal's own user.
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-progress",
    "--package-lock=false",
    // One line per registry request — this is what makes the drawer show live
    // progress instead of a single "installing..." for several minutes.
    "--loglevel=http",
    // Also on the CLI, not just in .npmrc: npm's precedence is cli > env >
    // .npmrc, so this is what actually guarantees the derived registry wins.
    `--registry=${registry}`,
    ...(platform ? [`--os=${platform.os}`, `--cpu=${platform.cpu}`] : []),
  ];

  // `npm run dev` fills process.env with the *portal's own* npm_config_*, and
  // env outranks a project .npmrc — an inherited npm_config_registry would
  // silently beat the registry we just derived. Works in prod (started by the
  // entrypoint), silently wrong in dev; strip them all rather than guess which.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_/i.test(key)) env[key] = value;
  }
  env.npm_config_cache = cacheDir;
  // Pin the user config at the .npmrc we wrote, so a developer's own ~/.npmrc
  // cannot redirect this install either.
  env.npm_config_userconfig = join(prefix, ".npmrc");

  // The token lives only in .npmrc — this line is echoed into a persisted log.
  onLog(`$ npm ${args.join(" ")}`);

  const deadline = AbortSignal.timeout(INSTALL_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, deadline]);

  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: prefix,
      env,
      signal: combined,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let mirrored = 0;
    let suppressed = 0;
    let requests = 0;
    let tail = "";
    const started = Date.now();

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      if (NPM_PROGRESS_RE.test(line)) {
        requests++;
        return;
      }
      if (mirrored < MAX_NPM_LOG_LINES) {
        mirrored++;
        onLog(line.trimEnd());
      } else {
        suppressed++;
      }
    };

    // npm writes almost everything — including plain progress — to stderr.
    const onChunk = (chunk: Buffer) => {
      tail += chunk.toString();
      const parts = tail.split("\n");
      tail = parts.pop() ?? "";
      for (const part of parts) handleLine(part);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    // The only sign of life during a long resolve, now that the per-request
    // lines are counted instead of mirrored.
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      onLog(`npm install still running (${seconds}s, ${requests} registry request(s))`);
    }, HEARTBEAT_MS);

    const settle = () => {
      clearInterval(heartbeat);
      if (tail.trim()) handleLine(tail);
      if (suppressed > 0) onLog(`(${suppressed} further npm line(s) suppressed)`);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle();
      if (err.code === "ENOENT") {
        reject(new Error("npm not found — ensure it is on PATH"));
        return;
      }
      // Our own deadline becomes a message; the user's Stop stays an AbortError
      // so RealArtifactoryApi can tell the two apart and keep a Stop a Stop.
      if (deadline.aborted && !signal.aborted) {
        reject(new Error(`npm install exceeded ${INSTALL_TIMEOUT_MS / 60000} minutes`));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      settle();
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
  });
}

/**
 * Every package in `name@version`'s runtime dependency tree, resolved by a real
 * `npm install` against `registry`.
 *
 * One install per target platform, each into its own prefix. A second install
 * into the *same* prefix would not add to the tree — npm reifies a whole new
 * ideal tree and prunes what is no longer in it, so the win32 pass would delete
 * the linux-only optional deps the first pass just fetched. The npm cache *is*
 * shared between the passes, which makes the second one nearly free.
 */
export async function resolveNpmDependencies(opts: {
  name: string;
  version: string;
  registry: string;
  token: string;
  /** `<jobTmp>/deps` — one subdirectory per platform pass underneath. */
  root: string;
  /** `<jobTmp>/npm-cache`, shared across passes and dropped with the job. */
  cacheDir: string;
  onLog: (line: string) => void;
  signal: AbortSignal;
}): Promise<DiscoveredPackage[]> {
  const spec = packageSpec(opts.name, opts.version);
  if (!spec) {
    throw new Error(`Refusing to install "${opts.name}@${opts.version}" — not a valid npm spec`);
  }

  const { stdout } = await execFileAsync("npm", ["--version"], { shell: useShell });
  const npmVersion = stdout.trim();
  const platforms: (Platform | null)[] = supportsPlatformFlags(npmVersion)
    ? [...DEP_PLATFORMS]
    : [null];
  if (platforms[0] === null) {
    opts.onLog(
      `npm ${npmVersion} has no --os/--cpu (added in 9.7.0) — resolving optional ` +
        `dependencies for ${process.platform}/${process.arch} only.`
    );
  }

  // Keyed name@version: the same package resolved by two platform passes is the
  // same bytes, so the first pass to find it wins.
  const found = new Map<string, DiscoveredPackage>();

  for (const platform of platforms) {
    if (opts.signal.aborted) break;
    const prefix = join(opts.root, platform ? `${platform.os}-${platform.cpu}` : "native");
    await mkdir(prefix, { recursive: true });
    // A real root manifest, so npm cannot walk *up* out of the temp dir looking
    // for one and adopt something unrelated as the project it is installing into.
    await writeFile(
      join(prefix, "package.json"),
      `${JSON.stringify({ name: "artifactory-url-copy", version: "0.0.0", private: true })}\n`
    );
    await writeFile(join(prefix, ".npmrc"), npmrcContents(opts.registry, opts.token), {
      mode: 0o600,
    });

    opts.onLog(
      platform
        ? `Resolving dependencies for ${platform.os}/${platform.cpu} ...`
        : "Resolving dependencies ..."
    );
    await runNpmInstall({
      spec,
      prefix,
      cacheDir: opts.cacheDir,
      registry: opts.registry,
      platform,
      onLog: opts.onLog,
      signal: opts.signal,
    });

    // node_modules, not the prefix: discoverPackages would otherwise pick up the
    // stub root manifest written above as a package to publish.
    for (const pkg of await discoverPackages(join(prefix, "node_modules"), opts.onLog)) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!found.has(key)) found.set(key, pkg);
    }
  }

  return [...found.values()];
}
