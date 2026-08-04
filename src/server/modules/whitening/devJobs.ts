import type { JobLogEntry, WhiteningJob } from "../../types";

/** `[step, line]` pairs read better than repeating the key 30 times. */
function log(entries: [string, string][]): JobLogEntry[] {
  return entries.map(([step, line]) => ({ step, line }));
}

/**
 * Demo jobs for local dev only — `app.ts` seeds these when `SSO_REQUIRED` is not
 * `true`, i.e. the same switch that already fakes the `dev` user. Whitening needs
 * Bitbucket, Artifactory and skopeo to produce a log, so without these the page
 * has nothing to show locally. Steps and line shapes mirror `RealWhiteningApi`.
 *
 * Submitters are mixed on purpose: as a user you see only your own job, as an
 * admin you see all of them and the All/Mine toggle has something to do.
 */
export function devWhiteningJobs(): WhiteningJob[] {
  return [
    {
      id: "WHT-0001",
      status: "completed",
      submittedBy: "dev",
      submittedByName: "Dev User",
      createdAt: "2026-08-04T11:31:07.000Z",
      updatedAt: "2026-08-04T11:33:52.000Z",
      archiveName: "dem-billing-api-2.4.0.tgz",
      department: "dem",
      team: "platform",
      project: "billing-api",
      version: "2.4.0",
      prUrl: "https://bitbucket.example.com/projects/PLATFORM/repos/billing-api/pull-requests/318",
      log: log([
        ["Prepare", "Unpacked dem-billing-api-2.4.0.tgz (48.2 MB)"],
        ["Clone", "Cloning platform/billing-api ..."],
        ["Clone", "$ git clone --depth 1 https://***@bitbucket.example.com/scm/platform/billing-api.git repo"],
        ["Clone", "Cloning into 'repo'..."],
        ["Clone", "$ git checkout -b whitening/billing-api-2.4.0"],
        ["Clone", "Switched to a new branch 'whitening/billing-api-2.4.0'"],
        ["Commit & push", "$ git add -A"],
        [
          "Commit & push",
          "$ git -c user.email=whitening@devops-portal -c user.name=Whitening commit -m Unpack dem-billing-api-2.4.0.tgz",
        ],
        ["Commit & push", "[whitening/billing-api-2.4.0 8f21ac4] Unpack dem-billing-api-2.4.0.tgz"],
        ["Commit & push", " 214 files changed, 9613 insertions(+), 71 deletions(-)"],
        ["Commit & push", "$ git push --force origin HEAD:whitening/billing-api-2.4.0"],
        ["Commit & push", "To https://bitbucket.example.com/scm/platform/billing-api.git"],
        ["Pull request", "Opening PR against main ..."],
        [
          "Pull request",
          "PR opened: https://bitbucket.example.com/projects/PLATFORM/repos/billing-api/pull-requests/318",
        ],
        ["Dependencies", "Found 12 package(s)."],
        ["Dependencies", "Checking 12 package(s) against npm-local ..."],
        ["Dependencies", "9 package(s) already in the repo — skipping."],
        ["Dependencies", "Uploaded fastify@4.26.2"],
        ["Dependencies", "Uploaded pino@8.19.0"],
        ["Dependencies", "Uploaded @sinclair/typebox@0.32.14"],
        ["Images", "Pushing api.tar -> docker://artifactory.example.com/docker-local/platform/billing-api/api:2.4.0 ..."],
        ["Images", "$ skopeo copy --dest-creds *** docker-archive:/tmp/wht-x9f2/images/api.tar docker://artifactory.example.com/docker-local/platform/billing-api/api:2.4.0"],
        ["Images", "Copying blob sha256:2d473b07cdd5 done"],
        ["Images", "Writing manifest to image destination"],
        ["Finish", "Done."],
      ]),
    },
    {
      id: "WHT-0002",
      status: "failed",
      submittedBy: "u-rin",
      submittedByName: "Rin Alvarez",
      createdAt: "2026-08-03T15:08:44.000Z",
      updatedAt: "2026-08-03T15:10:02.000Z",
      archiveName: "dem-auth-svc-1.9.3.tgz",
      department: "dem",
      team: "platform",
      project: "auth-svc",
      version: "1.9.3",
      prUrl: "https://bitbucket.example.com/projects/PLATFORM/repos/auth-svc/pull-requests/207",
      errorMessage: "skopeo: authentication required",
      log: log([
        ["Prepare", "Unpacked dem-auth-svc-1.9.3.tgz (31.7 MB)"],
        ["Clone", "Cloning platform/auth-svc ..."],
        ["Clone", "$ git clone --depth 1 https://***@bitbucket.example.com/scm/platform/auth-svc.git repo"],
        ["Clone", "$ git checkout -b whitening/auth-svc-1.9.3"],
        ["Commit & push", "$ git add -A"],
        ["Commit & push", "$ git push --force origin HEAD:whitening/auth-svc-1.9.3"],
        ["Pull request", "Opening PR against main ..."],
        ["Pull request", "A pull request from this branch is already open — reusing it."],
        [
          "Pull request",
          "PR opened: https://bitbucket.example.com/projects/PLATFORM/repos/auth-svc/pull-requests/207",
        ],
        ["Dependencies", "Found 4 package(s)."],
        ["Dependencies", "Checking 4 package(s) against npm-local ..."],
        ["Dependencies", "4 package(s) already in the repo — skipping."],
        ["Images", "Pushing auth.tar -> docker://artifactory.example.com/docker-local/platform/auth-svc/auth:1.9.3 ..."],
        ["Images", "$ skopeo copy --dest-creds *** docker-archive:/tmp/wht-b41c/images/auth.tar docker://artifactory.example.com/docker-local/platform/auth-svc/auth:1.9.3"],
        ["Images", "Error: authentication required"],
        ["Images", "Error: skopeo: authentication required"],
      ]),
    },
  ];
}
