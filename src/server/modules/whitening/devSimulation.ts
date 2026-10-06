import type { WhiteningJob, WhiteningScenario } from "../../types";

/**
 * Scripted stand-in for a real unpack. `npm run dev` has no Bitbucket, no
 * Artifactory and no skopeo behind it, so the Test button replays this instead
 * — same job map, same step-tagged log and the same abort controller as a real
 * run, so Stop works on it too.
 *
 * One scenario is a clean run; the other three replay the failure `run()`
 * produces when Bitbucket, the dependency upload, or the image push fails —
 * step names and line shapes mirror what `RealWhiteningApi` actually emits.
 *
 * Dev only: the route that starts it is not mounted when SSO is required.
 */
export type WhiteningBeat = {
  /** Waited out *before* the beat is applied. */
  ms: number;
  step?: string;
  line?: string;
  patch?: Partial<WhiteningJob>;
  /** Holds the run on the preserve prompt with these paths, exactly as a real run does. */
  ask?: string[];
};

export const WHITENING_SCENARIOS: readonly WhiteningScenario[] = [
  "success",
  "preserve-conflict",
  "clone-failure",
  "dependency-failure",
  "image-failure",
];

const PR_URL = "https://bitbucket.example.com/projects/PLATFORM/repos/billing-api/pull-requests/312";

const PREPARE: WhiteningBeat[] = [
  { ms: 400, step: "Prepare", patch: { status: "in-progress" } },
  { ms: 600, line: "Extracted billing-api-2.4.0.tgz (18.4 MB)." },
];

const CLONE_AND_PR: WhiteningBeat[] = [
  { ms: 800, step: "Clone", line: "Cloning platform/billing-api ..." },
  { ms: 900, line: "$ git clone --depth 1 https://bitbucket.example.com/scm/platform/billing-api.git repo" },
  { ms: 1100, line: "Cloning into 'repo'..." },
  { ms: 600, line: "$ git checkout -b whitening/billing-api-2.4.0" },

  { ms: 700, step: "Commit & push", line: "$ git add -A" },
  { ms: 700, line: "$ git commit -m Unpack billing-api-2.4.0.tgz" },
  { ms: 900, line: " 34 files changed, 1281 insertions(+), 402 deletions(-)" },
  { ms: 1000, line: "$ git push --force origin HEAD:whitening/billing-api-2.4.0" },

  { ms: 700, step: "Pull request", line: "Opening PR against main ..." },
  { ms: 900, line: `PR opened: ${PR_URL}`, patch: { prUrl: PR_URL } },
];

/** The pack ships three files the target repo's preserve list covers. */
const PRESERVE_CONFLICT: WhiteningBeat[] = [
  { ms: 800, step: "Clone", line: "Cloning platform/billing-api ..." },
  { ms: 900, line: "$ git clone --depth 1 https://bitbucket.example.com/scm/platform/billing-api.git repo" },
  { ms: 600, line: "$ git checkout -b whitening/billing-api-2.4.0" },
  { ms: 700, step: "Commit & push", line: "$ git add -A" },
  { ms: 600, line: "Kept 2 file(s) marked preserve in whitening.json." },
  { ms: 500, ask: ["whitening.json", ".github/workflows/ci.yml", "local.env"] },
  { ms: 600, line: "$ git commit -m Unpack billing-api-2.4.0.tgz" },
  { ms: 900, line: "$ git push --force origin HEAD:whitening/billing-api-2.4.0" },
  { ms: 700, step: "Pull request", line: "Opening PR against main ..." },
  { ms: 900, line: `PR opened: ${PR_URL}`, patch: { prUrl: PR_URL } },
];

const DEPENDENCIES: WhiteningBeat[] = [
  { ms: 700, step: "Dependencies", line: "Found 3 package(s)." },
  { ms: 800, line: "Checking 3 package(s) against npm-local ..." },
  { ms: 900, line: "1 package(s) already in the repo — skipping." },
  { ms: 1100, line: "Uploaded left-pad@1.3.0" },
  { ms: 1100, line: "Uploaded @babel/core@7.24.0" },
];

const IMAGES: WhiteningBeat[] = [
  {
    ms: 700,
    step: "Images",
    line: "Pushing images/api.tar -> docker://artifactory.example.com/docker-local/platform/billing-api/api:2.4.0 ...",
  },
  { ms: 1400, line: "Copying blob sha256:9f3c2b1e done" },
  { ms: 800, line: "Writing manifest to image destination" },
];

const FINISH: WhiteningBeat = { ms: 600, step: "Finish", line: "Done.", patch: { status: "completed" } };

/** Mirrors `pushSourceAndOpenPr`'s repo-existence probe failing. */
const CLONE_FAILURE: WhiteningBeat[] = [
  { ms: 800, step: "Clone", line: "Cloning platform/billing-api ..." },
  {
    ms: 900,
    line: "Bitbucket has no repository platform/billing-api — check config.json's team and repository",
    patch: {
      status: "failed",
      errorMessage: "Bitbucket has no repository platform/billing-api — check config.json's team and repository",
    },
  },
];

/** Mirrors `uploadDependencies` throwing after a package fails to upload. */
const DEPENDENCY_FAILURE: WhiteningBeat[] = [
  { ms: 700, step: "Dependencies", line: "Found 3 package(s)." },
  { ms: 800, line: "Checking 3 package(s) against npm-local ..." },
  { ms: 900, line: "1 package(s) already in the repo — skipping." },
  { ms: 1100, line: "Uploaded left-pad@1.3.0" },
  { ms: 1100, line: "Failed @babel/core@7.24.0: Artifactory responded 403 Forbidden" },
  {
    ms: 700,
    line: "Error: 1 of 3 dependency package(s) failed to upload",
    patch: { status: "failed", errorMessage: "1 of 3 dependency package(s) failed to upload" },
  },
];

/** Mirrors `uploadImages`'s skopeo call failing on a bad registry login. */
const IMAGE_FAILURE: WhiteningBeat[] = [
  {
    ms: 700,
    step: "Images",
    line: "Pushing images/api.tar -> docker://artifactory.example.com/docker-local/platform/billing-api/api:2.4.0 ...",
  },
  {
    ms: 900,
    line: "Error: unauthorized: authentication required",
    patch: { status: "failed", errorMessage: "unauthorized: authentication required" },
  },
];

const SCENARIO_BEATS: Record<WhiteningScenario, WhiteningBeat[]> = {
  success: [...PREPARE, ...CLONE_AND_PR, ...DEPENDENCIES, ...IMAGES, FINISH],
  "preserve-conflict": [...PREPARE, ...PRESERVE_CONFLICT, ...DEPENDENCIES, ...IMAGES, FINISH],
  "clone-failure": [...PREPARE, ...CLONE_FAILURE],
  "dependency-failure": [...PREPARE, ...CLONE_AND_PR, ...DEPENDENCY_FAILURE],
  "image-failure": [...PREPARE, ...CLONE_AND_PR, ...DEPENDENCIES, ...IMAGE_FAILURE],
};

/** Roughly 8-13 s end to end — long enough to switch tabs or hit Stop mid-run. */
export function whiteningSimulation(scenario: WhiteningScenario): WhiteningBeat[] {
  return SCENARIO_BEATS[scenario];
}

/** The job the beats are applied to — same archive for every scenario, only the outcome differs. */
export function simulatedWhiteningJob(): Pick<
  WhiteningJob,
  "archiveName" | "department" | "team" | "project" | "version"
> {
  return {
    archiveName: "billing-api-2.4.0.tgz",
    department: "engineering",
    team: "platform",
    project: "billing-api",
    version: "2.4.0",
  };
}
