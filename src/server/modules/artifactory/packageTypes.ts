import { config } from "../../config";
import type { PackageType } from "../../types";

export type Classified = {
  type: PackageType;
  /** Full repo-relative target, repo prefix included. */
  path: string;
  name: string;
  version: string;
};

/** Conda channel subdirs. A package outside one of these is assumed noarch. */
const CONDA_SUBDIRS = new Set([
  "noarch",
  "linux-64",
  "linux-32",
  "linux-aarch64",
  "linux-ppc64le",
  "linux-s390x",
  "osx-64",
  "osx-arm64",
  "win-64",
  "win-32",
]);

/** Checksums and Maven's own bookkeeping ride along with a validated artifact. */
const MAVEN_SIDECARS = [".sha1", ".sha256", ".sha512", ".md5", ".asc"];
const MAVEN_ARTIFACTS = [".jar", ".pom", ".war", ".ear", ".aar", ".zip", ".module"];

/** `name-version-release.arch.rpm` — release and arch are the last two fields. */
const RPM_RE = /^(.+)-([^-]+)-[^-]+\.[^.]+\.rpm$/;
/** `name-version-buildstring.conda` — build string is the last field. */
const CONDA_RE = /^(.+)-([^-]+)-[^-]+$/;
/** An sdist is `name-version.tar.gz` (or, legacily, `.zip`); the version starts with a digit. */
const SDIST_RE = /^(.+?)-(\d[^-]*)\.(?:tar\.gz|zip)$/;

function repoFor(type: PackageType): string {
  const { npmRepo, mavenRepo, rpmRepo, pypiRepo, condaRepo, helmRepo } = config.artifactory;
  return { npm: npmRepo, maven: mavenRepo, rpm: rpmRepo, pypi: pypiRepo, conda: condaRepo, helm: helmRepo }[type];
}

/**
 * Helm charts sit flat at the repo root: Artifactory's Helm indexer builds
 * index.yaml from each chart's own Chart.yaml, so the path carries nothing —
 * the same reason RPM and PyPI are flat. `null` when ARTIFACTORY_HELM_REPO is
 * unset, which the callers report as a skip like any other missing type repo.
 */
export function helmTargetPath(name: string, version: string, onSkip: (message: string) => void = () => {}) {
  if (!config.artifactory.helmRepo) {
    onSkip(`ARTIFACTORY_HELM_REPO not set — skipping ${name}-${version}.tgz`);
    return null;
  }
  return `${config.artifactory.helmRepo}/${name}-${version}.tgz`;
}

function envVarFor(type: PackageType): string {
  return `ARTIFACTORY_${type.toUpperCase()}_REPO`;
}

/**
 * Maven is the only type whose target cannot be derived from the filename — a jar
 * carries no groupId in its name. We take it from the directory layout instead,
 * which is how Maven deps actually arrive offline (`~/.m2/repository`, or
 * `mvn dependency:copy-dependencies -Dmdep.useRepositoryLayout=true`).
 *
 * `org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar` validates
 * because the filename starts with `<artifactId>-<version>`. A flat dump of jars
 * does not, and is skipped rather than guessed at.
 */
function classifyMaven(segments: string[], file: string): Omit<Classified, "path"> | null {
  if (segments.length < 4) return null;
  const artifactId = segments[segments.length - 3];
  const version = segments[segments.length - 2];
  if (!file.startsWith(`${artifactId}-${version}`)) return null;
  const groupId = segments.slice(0, -3).join(".");
  if (!groupId) return null;
  return { type: "maven", name: `${groupId}:${artifactId}`, version };
}

/**
 * Route one artifact to its repo and target path, from its path alone — nothing
 * here opens a file. Returns `null` when the path is not a recognised artifact,
 * or when the repo for its type is not configured; either way the caller falls
 * back to the raw-tree upload.
 *
 * `relativePath` is the path within the dropped folder (or the artifact-relative
 * tail of a source URL), always forward-slashed.
 */
export function classify(relativePath: string, onSkip: (message: string) => void = () => {}): Classified | null {
  const segments = relativePath.split("/").filter(Boolean);
  const file = segments[segments.length - 1];
  if (!file) return null;
  const lower = file.toLowerCase();

  const found = classifyPath(segments, file, lower);
  if (!found) return null;

  const repo = repoFor(found.type);
  if (!repo) {
    onSkip(`${envVarFor(found.type)} not set — skipping ${file}`);
    return null;
  }

  const { suffix, ...classified } = found;
  return { ...classified, path: `${repo}/${suffix}` };
}

/** The type table. `suffix` is the path below the repo root. */
function classifyPath(
  segments: string[],
  file: string,
  lower: string
): (Omit<Classified, "path"> & { suffix: string }) | null {
  if (lower.endsWith(".rpm")) {
    const m = RPM_RE.exec(file);
    if (!m) return null;
    // Artifactory's YUM indexer reads the RPM header itself, so a flat layout is
    // correct — the path carries no meaning.
    return { type: "rpm", name: m[1], version: m[2], suffix: file };
  }

  if (lower.endsWith(".whl")) {
    const [name, version] = file.split("-");
    if (!name || !version) return null;
    // Same as RPM: Artifactory reads the wheel's own METADATA to build the index.
    return { type: "pypi", name, version, suffix: file };
  }

  if (lower.endsWith(".conda") || lower.endsWith(".tar.bz2")) {
    const stem = file.replace(/\.(conda|tar\.bz2)$/i, "");
    const m = CONDA_RE.exec(stem);
    if (!m) return null;
    // ponytail: subdir comes from the channel directory the file sits in, else
    // noarch. A wrong guess indexes the package under the wrong platform rather
    // than failing — read it out of the package's info/index.json if that bites.
    const subdir = segments.slice(0, -1).reverse().find((s) => CONDA_SUBDIRS.has(s)) ?? "noarch";
    return { type: "conda", name: m[1], version: m[2], suffix: `${subdir}/${file}` };
  }

  if (MAVEN_ARTIFACTS.some((e) => lower.endsWith(e)) || MAVEN_SIDECARS.some((e) => lower.endsWith(e))) {
    // A sidecar validates against the artifact it belongs to: strip its suffix
    // first so `...-3.12.0.jar.sha1` checks as `...-3.12.0.jar`.
    const sidecar = MAVEN_SIDECARS.find((e) => lower.endsWith(e));
    const artifact = sidecar ? file.slice(0, -sidecar.length) : file;
    if (!MAVEN_ARTIFACTS.some((e) => artifact.toLowerCase().endsWith(e))) return null;
    const coords = classifyMaven(segments, artifact);
    // The layout IS the target — upload the relative path verbatim.
    // Falling through rather than returning null: `.zip` is both a Maven
    // artifact and a (legacy) Python sdist, and only the layout tells them
    // apart. A `.jar` that gets here has its coordinates read out of the file
    // itself by the caller.
    if (coords) return { ...coords, suffix: segments.join("/") };
  }

  // An sdist check has to come after the Maven and conda tarball rules so it does
  // not swallow them; `.tgz` stays with the npm path, which sniffs file contents.
  const sdist = SDIST_RE.exec(file);
  if (sdist) return { type: "pypi", name: sdist[1], version: sdist[2], suffix: file };

  return null;
}

/**
 * Artifactory's own UI links are what people copy out of the browser — the tree
 * browser (`/ui/repos/tree/General/<repo>/<path>`, which is exactly what this
 * app's own `webUrl` hands back) and the package view (`/ui/native/<repo>/<path>`).
 * Neither serves bytes. Both name the repo-relative path, so rewriting them to
 * the download URL (`/artifactory/<repo>/<path>`) is mechanical, and anything
 * else is returned untouched.
 */
export function downloadUrl(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "ui") return sourceUrl;
  // `General` is the tree browser's own root node, not part of the repo path.
  const rest =
    segments[1] === "repos" && segments[2] === "tree"
      ? segments.slice(segments[3] === "General" ? 4 : 3)
      : segments[1] === "native"
        ? segments.slice(2)
        : null;
  if (!rest || rest.length === 0) return sourceUrl;
  url.pathname = `/artifactory/${rest.join("/")}`;
  return url.toString();
}

/** Repository roots that sit above the artifact path in a public repo URL. */
const URL_ROOTS_1 = new Set(["maven2", "maven", "content", "m2"]);
const URL_ROOTS_2 = new Set(["artifactory", "repository", "repo"]);

/**
 * The artifact-relative tail of a source URL, so `classify` sees the same shape a
 * dropped folder gives it. `/maven2/org/apache/commons/...` must become
 * `org/apache/commons/...` or the groupId picks up the repo root.
 *
 * ponytail: a short known-roots list, covering Maven Central, JFrog and Nexus. An
 * unrecognised host yields a group one segment too deep, not a wrong one, and the
 * job logs the target it chose before uploading.
 */
export function urlArtifactPath(sourceUrl: string): string {
  const segments = new URL(sourceUrl).pathname.split("/").filter(Boolean);
  if (URL_ROOTS_2.has(segments[0])) return segments.slice(2).join("/");
  if (URL_ROOTS_1.has(segments[0])) return segments.slice(1).join("/");
  return segments.join("/");
}

/**
 * The `<artifactId>-<version>.pom` beside a Maven artifact URL, or `null` when
 * the URL already points at that pom. A jar on its own is unresolvable — the pom
 * is what carries the transitive dependencies — and a URL copy fetches only the
 * URL that was pasted.
 *
 * The name comes from the layout, not from swapping the extension, so a
 * classifier build (`bar-1.0-sources.jar`) still asks for `bar-1.0.pom`. Any
 * query string on the source URL (a token) is kept.
 */
export function mavenPomUrl(sourceUrl: string): string | null {
  const url = new URL(sourceUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4) return null;
  const [artifactId, version] = segments.slice(-3, -1);
  const pom = `${artifactId}-${version}.pom`;
  if (segments[segments.length - 1] === pom) return null;
  segments[segments.length - 1] = pom;
  url.pathname = `/${segments.join("/")}`;
  return url.toString();
}

/** Maven coordinates, as read out of a pom. */
export type MavenCoords = { groupId: string; artifactId: string; version: string };

/**
 * Where the pom for these coordinates belongs, relative to the Maven repo root.
 * The layout IS the address: Artifactory rejects a pom deployed anywhere else
 * with a 409, because its own coordinates disagree with the path.
 */
export function mavenLayoutPath(coords: MavenCoords, filename: string): string {
  return `${coords.groupId.replace(/\./g, "/")}/${coords.artifactId}/${coords.version}/${filename}`;
}

/**
 * A pom's own `groupId:artifactId:version`, or `null` if it does not state all
 * three. A child pom omits the groupId and version it inherits, so `<parent>`
 * supplies whichever of the two is missing.
 *
 * ponytail: a scan, not an XML parser — everything below `<dependencies>` and
 * friends is cut away first, because a *dependency's* `<groupId>` would
 * otherwise pass for the project's own. Every caller cross-checks the result
 * against the path the file actually sits at, so a misparse is caught rather
 * than published. Reach for a real parser only if a pom in the wild slips past
 * both.
 */
export function mavenCoordsFromPom(xml: string): MavenCoords | null {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");
  const parent = /<parent\b[^>]*>([\s\S]*?)<\/parent>/i.exec(withoutComments);
  let body = parent ? withoutComments.replace(parent[0], "") : withoutComments;
  // The project's own coordinates are the only ones above these elements.
  const rest = /<(dependencies|dependencyManagement|build|profiles|modules|reporting|repositories)\b/i.exec(body);
  if (rest) body = body.slice(0, rest.index);

  const pick = (tag: string, from: string) =>
    new RegExp(`<${tag}\\s*>([^<]*)</${tag}\\s*>`, "i").exec(from)?.[1].trim() ?? "";

  const artifactId = pick("artifactId", body);
  const groupId = pick("groupId", body) || (parent ? pick("groupId", parent[1]) : "");
  const version = pick("version", body) || (parent ? pick("version", parent[1]) : "");
  if (!groupId || !artifactId || !version) return null;
  return { groupId, artifactId, version };
}

/**
 * How many leading segments of `pomPath` sit *above* the Maven layout the pom
 * describes — `null` when the path and the pom disagree, which is the check that
 * makes this safe to trust.
 *
 * `m2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom` for
 * groupId `org.apache.commons` gives 1: the `m2` above the group root. Folding
 * that into the groupId is what makes a dropped tree upload to a path nothing
 * resolves from.
 */
export function mavenRootDepth(pomPath: string, coords: MavenCoords): number | null {
  const segments = pomPath.split("/").filter(Boolean);
  const group = coords.groupId.split(".");
  // <prefix…> <group…> <artifactId> <version> <file>
  const depth = segments.length - 3 - group.length;
  if (depth < 0) return null;
  if (segments[segments.length - 3] !== coords.artifactId) return null;
  if (segments[segments.length - 2] !== coords.version) return null;
  if (group.some((part, i) => segments[depth + i] !== part)) return null;
  return depth;
}
