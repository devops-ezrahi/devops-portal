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
/** An sdist is `name-version.tar.gz`; the version must start with a digit. */
const SDIST_RE = /^(.+?)-(\d[^-]*)\.tar\.gz$/;

function repoFor(type: PackageType): string {
  const { npmRepo, mavenRepo, rpmRepo, pypiRepo, condaRepo } = config.artifactory;
  return { npm: npmRepo, maven: mavenRepo, rpm: rpmRepo, pypi: pypiRepo, conda: condaRepo }[type];
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
    return coords && { ...coords, suffix: segments.join("/") };
  }

  // An sdist check has to come after the Maven and conda tarball rules so it does
  // not swallow them; `.tgz` stays with the npm path, which sniffs file contents.
  const sdist = SDIST_RE.exec(file);
  if (sdist) return { type: "pypi", name: sdist[1], version: sdist[2], suffix: file };

  return null;
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
