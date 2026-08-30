import { cp, mkdir, readdir, writeFile } from "fs/promises";
import { join, relative } from "path";
import { classify, mavenLayoutPath } from "./packageTypes";
import type { MavenCoords } from "./packageTypes";
import type { UploadItem } from "./npmPackages";
import { runTool, toolVersion } from "./runTool";

/**
 * Per resolve, on top of the job's own AbortSignal — same reasoning as npm's:
 * that signal only fires when a human presses Stop, and without a deadline a
 * wedged repository pins an in-progress job, its temp dir and the pod's disk.
 */
const RESOLVE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Pinned by full coordinates rather than the `dependency:` prefix. Prefix
 * resolution does a metadata lookup against the mirror and takes whatever is
 * newest — a failure in a closed network, and non-reproducible in an open one.
 */
const DEPENDENCY_PLUGIN = "org.apache.maven.plugins:maven-dependency-plugin:3.6.1";

/**
 * Pre-warmed at image build time (see the Dockerfile), copied per job rather
 * than used in place: two concurrent jobs writing one local repository is the
 * classic way to get a half-downloaded jar. The copy is ~15 MB and local.
 *
 * Missing is fine — maven then fetches the plugin through the mirror, which
 * works wherever the mirror proxies plugins.
 */
const BAKED_M2 = "/opt/m2";

/** Maven's own progress chatter — counted, not mirrored. */
const MVN_PROGRESS_RE = /^(?:Progress \(|Downloading from |Downloaded from |Progress:)/;
/** One `Downloading …` per file on top of the `Collecting`/`Saved` lines that say what resolved. */
const PIP_PROGRESS_RE = /^\s*Downloading /;

/**
 * The repository root a Maven artifact URL was served from.
 *
 * The layout *is* the address, so there is nothing to guess: strip the path the
 * coordinates describe off the end of the URL and what remains is the root.
 *
 *   https://repo1.maven.org/maven2/org/foo/bar/1.0/bar-1.0.jar
 *     -> https://repo1.maven.org/maven2
 *
 * `null` when the URL does not end with that path — the same stance
 * `npmRegistryFromUrl` takes, because a guessed root buys a timeout in a closed
 * network and silently resolves against the wrong repository in an open one.
 */
export function mavenRepoFromUrl(
  sourceUrl: string,
  coords: MavenCoords,
  filename: string
): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const suffix = `/${mavenLayoutPath(coords, filename)}`;
  const path = decodeURIComponent(url.pathname);
  if (!path.endsWith(suffix)) return null;

  const base = path.slice(0, -suffix.length).replace(/\/+$/, "");
  return base ? `${url.origin}${base}` : url.origin;
}

/**
 * The PEP 503 simple index a wheel or sdist URL was served from.
 *
 * Every repository that serves Python packages puts the files under a
 * `packages/` segment and the index beside it — PyPI itself
 * (`files.pythonhosted.org`, whose index lives on another host entirely),
 * Artifactory (`…/api/pypi/<repo>/packages/…`) and Nexus
 * (`…/repository/<name>/packages/…`). `null` for anything else, e.g. a release
 * asset on a flat file server, where there is no index to resolve against.
 */
export function pypiIndexFromUrl(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // PyPI serves files off a CDN host that has no index on it at all.
  if (url.host === "files.pythonhosted.org") return "https://pypi.org/simple";

  const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  const at = segments.indexOf("packages");
  if (at < 0) return null;
  const base = segments.slice(0, at);
  return `${url.origin}${base.length ? `/${base.join("/")}` : ""}/simple`;
}

/** PEP 508's name grammar, and an exact version off a filename. */
const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PYPI_VERSION_RE = /^[A-Za-z0-9.!+_-]+$/;
/** Maven coordinates never contain a path or shell metacharacter. */
const MAVEN_PART_RE = /^[A-Za-z0-9._-]+$/;

/**
 * `name==version`, or `null` for anything we refuse to hand to a subprocess.
 * The name comes off a filename in a user-supplied URL, so it is
 * attacker-controlled: unvalidated it reaches a pip argv, where a leading `-`
 * alone turns a package name into a flag.
 */
export function pypiSpec(name: string, version: string): string | null {
  if (name.length === 0 || name.length > 214) return null;
  if (!PYPI_NAME_RE.test(name) || !PYPI_VERSION_RE.test(version)) return null;
  return `${name}==${version}`;
}

/** The same guard for Maven coordinates, which reach both an argv and an XML file. */
export function validMavenCoords(coords: MavenCoords): boolean {
  return (
    MAVEN_PART_RE.test(coords.groupId) &&
    MAVEN_PART_RE.test(coords.artifactId) &&
    MAVEN_PART_RE.test(coords.version)
  );
}

/**
 * Every file under `dir` that `classify` recognises, as upload items.
 *
 * This is the whole reason running the real client is cheap: `mvn
 * -Dmdep.useRepositoryLayout=true` writes `<group as dirs>/<artifact>/<version>/
 * <file>` and `pip download -d` writes a flat directory of wheels, which are
 * exactly the two shapes the folder-upload path already routes. Nothing here
 * knows which tool produced the directory.
 */
export async function itemsFromResolvedDir(
  dir: string,
  onSkip: (message: string) => void = () => {}
): Promise<UploadItem[]> {
  const items: UploadItem[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const found = classify(relative(dir, full).split("\\").join("/"), onSkip);
      if (!found) continue;
      items.push({ ...found, resolve: async () => full });
    }
  };

  await walk(dir);
  return items;
}

/** A stub project whose only dependency is the artifact being copied. */
export function stubPom(coords: MavenCoords): string {
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>portal.urlcopy</groupId>
  <artifactId>url-copy</artifactId>
  <version>0.0.0</version>
  <packaging>pom</packaging>
  <dependencies>
    <dependency>
      <groupId>${coords.groupId}</groupId>
      <artifactId>${coords.artifactId}</artifactId>
      <version>${coords.version}</version>
    </dependency>
  </dependencies>
</project>
`;
}

/**
 * `<mirrorOf>*</mirrorOf>` so a closed network never reaches for Central, plus
 * the token as a password — Artifactory takes an access token that way under
 * any username, which is far less brittle than wagon's httpHeaders form.
 */
export function mavenSettings(repo: string, token: string): string {
  const server = token
    ? `
  <servers>
    <server>
      <id>source</id>
      <username>portal</username>
      <password>${token}</password>
    </server>
  </servers>`
    : "";
  return `<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">${server}
  <mirrors>
    <mirror>
      <id>source</id>
      <url>${repo}</url>
      <mirrorOf>*</mirrorOf>
    </mirror>
  </mirrors>
</settings>
`;
}

/**
 * Every runtime dependency of `coords`, resolved by a real
 * `dependency:copy-dependencies` against `repo`.
 *
 * `null` when maven is not installed — the image may or may not carry it, and a
 * dev box usually does not. The caller turns that into a log line and copies the
 * single artifact, exactly as it does for a tree that will not resolve.
 */
export async function resolveMavenDependencies(opts: {
  coords: MavenCoords;
  repo: string;
  token: string;
  /** `<jobTmp>/mvn` — the stub project, its settings and the output live here. */
  root: string;
  onLog: (line: string) => void;
  signal: AbortSignal;
}): Promise<UploadItem[] | null> {
  if (!validMavenCoords(opts.coords)) {
    throw new Error(
      `Refusing to resolve "${opts.coords.groupId}:${opts.coords.artifactId}:${opts.coords.version}" — not valid coordinates`
    );
  }

  const version = await toolVersion("mvn", ["-v"]);
  if (version === null) return null;
  opts.onLog(version);

  const out = join(opts.root, "out");
  const localRepo = join(opts.root, "m2");
  await mkdir(opts.root, { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(opts.root, "pom.xml"), stubPom(opts.coords));
  // The token is in this file and nowhere else — never on the command line,
  // which is echoed into a persisted job log.
  await writeFile(join(opts.root, "settings.xml"), mavenSettings(opts.repo, opts.token), {
    mode: 0o600,
  });
  // ponytail: a per-job copy of the baked plugin cache. A shared cache under
  // DATA_DIR is the upgrade if the copy ever shows up in job times.
  await cp(BAKED_M2, localRepo, { recursive: true }).catch(() => {});

  opts.onLog(`Resolving dependencies of ${opts.coords.artifactId} ...`);
  await runTool({
    bin: "mvn",
    args: [
      "-B",
      "-ntp",
      "-s",
      join(opts.root, "settings.xml"),
      `-Dmaven.repo.local=${localRepo}`,
      `${DEPENDENCY_PLUGIN}:copy-dependencies`,
      // The layout classifyMaven reads, and each dependency's own pom beside
      // its jar — a copied jar without its pom is unresolvable for anyone
      // consuming the repo.
      "-Dmdep.useRepositoryLayout=true",
      "-Dmdep.copyPom=true",
      // compile + runtime, dropping test and provided. npm's --omit=dev.
      "-DincludeScope=runtime",
      // Deliberately *not* maven.repo.local: only this directory is uploaded,
      // so the dependency plugin's own jars stay in the local repo and are
      // never published into the customer's Artifactory.
      `-DoutputDirectory=${out}`,
    ],
    cwd: opts.root,
    quietRe: MVN_PROGRESS_RE,
    quietNoun: "transfer",
    timeoutMs: RESOLVE_TIMEOUT_MS,
    onLog: opts.onLog,
    signal: opts.signal,
  });

  return itemsFromResolvedDir(out, opts.onLog);
}

/**
 * Every dependency of `name==version`, resolved by a real `pip download`
 * against `index`. `null` when pip is not installed.
 *
 * Wheels only. `pip download` runs a package's `setup.py` for any sdist it
 * fetches, as the portal's own user — the same door the npm path closes with
 * `--ignore-scripts`. A tree containing an sdist-only package therefore fails to
 * resolve, and the caller copies the single artifact and says so.
 *
 * ponytail: one pass, for this pod's own platform tags. npm resolves twice
 * because optional deps are platform-gated and wheels are tagged the same way —
 * add a DEP_PLATFORMS-style loop with --platform/--python-version here if a
 * Windows consumer ever needs the mirror.
 */
export async function resolvePypiDependencies(opts: {
  name: string;
  version: string;
  index: string;
  /** `<jobTmp>/pip` — the downloaded wheels land here. */
  root: string;
  onLog: (line: string) => void;
  signal: AbortSignal;
}): Promise<UploadItem[] | null> {
  const spec = pypiSpec(opts.name, opts.version);
  if (!spec) {
    throw new Error(`Refusing to download "${opts.name}==${opts.version}" — not a valid pip spec`);
  }

  const version = await toolVersion("python3", ["-m", "pip", "--version"]);
  if (version === null) return null;
  opts.onLog(version);

  await mkdir(opts.root, { recursive: true });

  opts.onLog(`Resolving dependencies of ${spec} ...`);
  await runTool({
    bin: "python3",
    args: [
      "-m",
      "pip",
      "download",
      spec,
      "--dest",
      opts.root,
      `--index-url=${opts.index}`,
      // Nothing is executed: see the note above.
      "--only-binary=:all:",
      "--no-input",
      "--disable-pip-version-check",
      "--no-color",
      // The bar redraws with \r and cursor escapes, which in a persisted log is
      // a few hundred bytes of noise per file rather than a progress indicator.
      "--progress-bar",
      "off",
    ],
    cwd: opts.root,
    quietRe: PIP_PROGRESS_RE,
    quietNoun: "download",
    timeoutMs: RESOLVE_TIMEOUT_MS,
    onLog: opts.onLog,
    signal: opts.signal,
  });

  return itemsFromResolvedDir(opts.root, opts.onLog);
}
