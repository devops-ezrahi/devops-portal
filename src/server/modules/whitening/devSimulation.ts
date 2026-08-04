import type { WhiteningJob } from "../../types";

/**
 * Scripted stand-in for a real unpack. `npm run dev` has no Bitbucket, no
 * Artifactory and no skopeo behind it, so the Test button replays this instead
 * — same job map, same step-tagged log and the same abort controller as a real
 * run, so Stop works on it too.
 *
 * Step names and line shapes mirror what `RealWhiteningApi` actually emits.
 * Dev only: the route that starts it is not mounted when SSO is required.
 */
export type WhiteningBeat = {
  /** Waited out *before* the beat is applied. */
  ms: number;
  step?: string;
  line?: string;
  patch?: Partial<WhiteningJob>;
};

const PR_URL = "https://bitbucket.example.com/projects/PLATFORM/repos/billing-api/pull-requests/312";

/** Roughly 13 s end to end — long enough to switch tabs or hit Stop mid-run. */
export const whiteningSimulation: WhiteningBeat[] = [
  { ms: 400, step: "Prepare", patch: { status: "in-progress" } },
  { ms: 600, line: "Extracted billing-api-2.4.0.tgz (18.4 MB)." },

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

  { ms: 700, step: "Dependencies", line: "Found 3 package(s)." },
  { ms: 800, line: "Checking 3 package(s) against npm-local ..." },
  { ms: 900, line: "1 package(s) already in the repo — skipping." },
  { ms: 1100, line: "Uploaded left-pad@1.3.0" },
  { ms: 1100, line: "Uploaded @babel/core@7.24.0" },

  { ms: 700, step: "Images", line: "Pushing images/api.tar -> docker://artifactory.example.com/docker-local/platform/billing-api/api:2.4.0 ..." },
  { ms: 1400, line: "Copying blob sha256:9f3c2b1e done" },
  { ms: 800, line: "Writing manifest to image destination" },

  { ms: 600, step: "Finish", line: "Done.", patch: { status: "completed" } },
];

/** The job the beats are applied to. */
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
