import type { ArtifactoryJob, ArtifactoryScenario, PackageType, PackageUploadResult } from "../../types";

/**
 * Scripted stand-in for a real folder upload. `npm run dev` has no Artifactory
 * behind it, so the Test button replays this instead — same job map, same log,
 * same progress and the same abort controller as a real run, which is what
 * makes the Stop button demonstrable offline.
 *
 * One scenario per package type exercises `packageTypes.ts`'s routing end to
 * end; two more replay the failure paths `finish()` and the folder-upload
 * `catch` produce for real.
 *
 * Dev only: the route that starts it is not mounted when SSO is required.
 */
export type SimulationBeat = {
  /** Waited out *before* the beat is applied. */
  ms: number;
  line?: string;
  patch?: Partial<ArtifactoryJob>;
};

export const ARTIFACTORY_SCENARIOS: readonly ArtifactoryScenario[] = [
  "npm",
  "maven",
  "rpm",
  "pypi",
  "helm",
  // ponytail: conda dropped from the Test menu — its repo path/link shape isn't
  // decided yet. PACKAGE_SCENARIOS.conda stays below so re-adding it is a
  // one-line change once that's settled.
  "partial-failure",
  "total-failure",
  "dependency-fallback",
];

const BASE = "https://artifactory.example.com";

/**
 * Maven's `path` differs from every other type: `name` is `groupId:artifactId`
 * for display, but the repo layout wants the groupId's dots turned into
 * directories, e.g. `com.google.guava:guava` + `32.1.3-jre` ->
 * `com/google/guava/guava/32.1.3-jre/guava-32.1.3-jre.pom` — mirrors
 * `classifyMaven` in packageTypes.ts for a package this simulation invents
 * rather than reads off disk. Links the `.pom`, not the `.jar`: every published
 * coordinate has one (some, like a parent POM, have no jar at all).
 */
function mavenPath(repo: string, name: string, version: string): string {
  const [groupId, artifactId] = name.split(":");
  return `${repo}/${groupId.replace(/\./g, "/")}/${artifactId}/${version}/${artifactId}-${version}.pom`;
}

/** Mirrors `targetPath` in npmPackages.ts, without npmPackages' hard dependency on `config`. */
function npmPath(repo: string, name: string, version: string): string {
  const filename = `${name.split("/").pop()}-${version}.tgz`;
  return `${repo}/${name}/-/${filename}`;
}

/** PyPI builds ship their wheel in `dist/` — link that file, not the package root. */
function pypiPath(repo: string, name: string, version: string): string {
  return `${repo}/dist/${name}-${version}-py3-none-any.whl`;
}

type PackageScenario = {
  folderName: string;
  repo: string;
  items: { name: string; version: string; status: "uploaded" | "exists" }[];
};

const PACKAGE_SCENARIOS: Record<PackageType, PackageScenario> = {
  npm: {
    folderName: "node_modules",
    repo: "npm-local",
    items: [
      { name: "arg", version: "4.1.5", status: "exists" },
      { name: "left-pad", version: "1.3.0", status: "uploaded" },
      { name: "@babel/core", version: "7.24.0", status: "uploaded" },
    ],
  },
  maven: {
    folderName: "m2-repository",
    repo: "maven-local",
    items: [
      { name: "org.apache.commons:commons-lang3", version: "3.12.0", status: "exists" },
      { name: "com.google.guava:guava", version: "32.1.3-jre", status: "uploaded" },
    ],
  },
  rpm: {
    folderName: "rpm-packages",
    repo: "yum-local",
    items: [
      { name: "openssl-libs", version: "3.0.7", status: "exists" },
      { name: "htop", version: "3.2.2", status: "uploaded" },
    ],
  },
  pypi: {
    folderName: "wheelhouse",
    repo: "pypi-local",
    items: [
      { name: "requests", version: "2.31.0", status: "exists" },
      { name: "numpy", version: "1.26.4", status: "uploaded" },
    ],
  },
  conda: {
    folderName: "conda-packages",
    repo: "conda-local",
    items: [
      { name: "numpy", version: "1.26.4", status: "uploaded" },
      { name: "scipy", version: "1.11.4", status: "uploaded" },
    ],
  },
  helm: {
    folderName: "charts",
    repo: "helm-local",
    items: [
      { name: "redis", version: "19.6.1", status: "exists" },
      { name: "ingress-nginx", version: "4.11.2", status: "uploaded" },
    ],
  },
};

/** A clean run through one package type: found, checked, uploaded, done. */
function packageTypeBeats(type: PackageType): SimulationBeat[] {
  const scenario = PACKAGE_SCENARIOS[type];
  const items: PackageUploadResult[] = scenario.items.map((i) => {
    const path =
      type === "maven"
        ? mavenPath(scenario.repo, i.name, i.version)
        : type === "npm"
          ? npmPath(scenario.repo, i.name, i.version)
          : type === "pypi"
            ? pypiPath(scenario.repo, i.name, i.version)
            : type === "helm"
              ? `${scenario.repo}/${i.name}-${i.version}.tgz`
              : `${scenario.repo}/${i.name}/${i.version}`;
    return { ...i, type, path, url: `${BASE}/ui/repos/tree/General/${path}`, nativeUrl: `${BASE}/ui/native/${path}` };
  });
  const uploaded = items.filter((i) => i.status === "uploaded").length;
  const skipped = items.length - uploaded;

  const beats: SimulationBeat[] = [
    { ms: 400, patch: { status: "in-progress" } },
    { ms: 600, line: `Writing ${items.length + 3} file(s) to temp directory ...` },
    {
      ms: 1200,
      line: `Found ${items.length} package(s).`,
      patch: { name: `${scenario.folderName} (${items.length} packages)` },
    },
    { ms: 1200, line: `Checking ${items.length} package(s) against ${scenario.repo} ...` },
  ];
  items.forEach((item, i) => {
    beats.push({
      ms: 1200 + i * 500,
      line:
        item.status === "exists"
          ? `${item.name}@${item.version} already in the repo — skipping.`
          : `Uploaded ${item.name}@${item.version}`,
      patch: { progress: { done: i + 1, total: items.length }, packages: items.slice(0, i + 1) },
    });
  });
  beats.push({
    ms: 1200,
    line: `Done. ${uploaded} uploaded, ${skipped} already present, 0 failed.`,
    patch: { status: "completed", resultUrl: `${BASE}/ui/repos/tree/General/${scenario.repo}` },
  });
  return beats;
}

/** Mirrors `RealArtifactoryApi.finish()` when one package out of several fails. */
function partialFailureBeats(): SimulationBeat[] {
  const tree = `${BASE}/ui/repos/tree/General/npm-local`;
  const argPath = npmPath("npm-local", "arg", "4.1.5");
  const leftPadPath = npmPath("npm-local", "left-pad", "1.3.0");
  const items: PackageUploadResult[] = [
    {
      name: "arg",
      version: "4.1.5",
      type: "npm",
      status: "exists",
      path: argPath,
      url: `${BASE}/ui/repos/tree/General/${argPath}`,
      nativeUrl: `${BASE}/ui/native/${argPath}`,
    },
    {
      name: "left-pad",
      version: "1.3.0",
      type: "npm",
      status: "uploaded",
      path: leftPadPath,
      url: `${BASE}/ui/repos/tree/General/${leftPadPath}`,
      nativeUrl: `${BASE}/ui/native/${leftPadPath}`,
    },
    {
      name: "@babel/core",
      version: "7.24.0",
      type: "npm",
      status: "failed",
      path: npmPath("npm-local", "@babel/core", "7.24.0"),
      error: "Artifactory responded 403 Forbidden",
    },
  ];
  return [
    { ms: 400, patch: { status: "in-progress" } },
    { ms: 600, line: "Writing 6 file(s) to temp directory ..." },
    { ms: 1200, line: "Found 3 package(s).", patch: { name: "node_modules (3 packages)" } },
    { ms: 1200, line: "Checking 3 package(s) against npm-local ..." },
    { ms: 1500, line: "arg@4.1.5 already in the repo — skipping.", patch: { progress: { done: 1, total: 3 }, packages: items.slice(0, 1) } },
    { ms: 2000, line: "Uploaded left-pad@1.3.0", patch: { progress: { done: 2, total: 3 }, packages: items.slice(0, 2) } },
    {
      ms: 2000,
      line: "Failed @babel/core@7.24.0: Artifactory responded 403 Forbidden",
      patch: { progress: { done: 3, total: 3 }, packages: items },
    },
    {
      ms: 1000,
      line: "Done. 1 uploaded, 1 already present, 1 failed.",
      patch: { status: "failed", errorMessage: "1 of 3 package(s) failed", resultUrl: tree },
    },
  ];
}

/** Mirrors the `catch` in `runFolderUpload` when Artifactory is unreachable. */
function totalFailureBeats(): SimulationBeat[] {
  return [
    { ms: 400, patch: { status: "in-progress" } },
    { ms: 600, line: "Writing 6 file(s) to temp directory ..." },
    { ms: 900, line: "Checking 3 package(s) against npm-local ..." },
    {
      ms: 1200,
      line: "Error: connect ECONNREFUSED artifactory.example.com:443",
      patch: { status: "failed", errorMessage: "connect ECONNREFUSED artifactory.example.com:443" },
    },
  ];
}

/**
 * The box was ticked and the tree would not resolve: the copy still happens,
 * the job still ends `completed`, and `dependencyFallback` is what stops the
 * badge from claiming the dependencies came with it.
 */
function dependencyFallbackBeats(): SimulationBeat[] {
  const path = npmPath("npm-local", "arg", "4.1.5");
  const item: PackageUploadResult = {
    name: "arg",
    version: "4.1.5",
    type: "npm",
    status: "uploaded",
    path,
    url: `${BASE}/ui/repos/tree/General/${path}`,
    nativeUrl: `${BASE}/ui/native/${path}`,
  };
  const reason = "Could not resolve dependencies (npm ERR! ENOTFOUND registry.npmjs.org)";
  return [
    { ms: 400, patch: { status: "in-progress" } },
    { ms: 700, line: "Downloading https://registry.npmjs.org/arg/-/arg-4.1.5.tgz ..." },
    { ms: 800, line: "The tarball says it is arg@4.1.5." },
    { ms: 900, line: "Source npm registry: https://registry.npmjs.org" },
    { ms: 2500, line: `${reason} — copying the single artifact.`, patch: { dependencyFallback: reason } },
    {
      ms: 1200,
      line: "Uploaded arg@4.1.5",
      patch: { progress: { done: 1, total: 1 }, packages: [item] },
    },
    {
      ms: 800,
      line: "Done. 1 uploaded, 0 already present, 0 failed.",
      patch: { status: "completed", resultUrl: item.url },
    },
  ];
}

/** Roughly 8-11 s end to end — long enough to switch tabs or hit Stop mid-run. */
export function artifactorySimulation(scenario: ArtifactoryScenario): SimulationBeat[] {
  if (scenario === "partial-failure") return partialFailureBeats();
  if (scenario === "total-failure") return totalFailureBeats();
  if (scenario === "dependency-fallback") return dependencyFallbackBeats();
  return packageTypeBeats(scenario);
}

/** The job the beats are applied to. */
export function simulatedArtifactoryJob(scenario: ArtifactoryScenario): Partial<ArtifactoryJob> {
  // The only url-copy scenario: the fallback is a thing only a URL copy does.
  if (scenario === "dependency-fallback") {
    return {
      kind: "url-copy",
      name: "arg@4.1.5",
      sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz",
      includeDependencies: true,
    };
  }
  const folderName =
    scenario === "partial-failure" || scenario === "total-failure" ? "node_modules" : PACKAGE_SCENARIOS[scenario].folderName;
  return {
    kind: "folder-upload",
    name: folderName,
    folderName,
    fileCount: 6,
    totalBytes: 224,
  };
}
