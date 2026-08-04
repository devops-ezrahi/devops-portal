import type { ArtifactoryJob } from "../../types";

/**
 * Demo jobs for local dev only — `app.ts` seeds these when `SSO_REQUIRED` is not
 * `true`, i.e. the same switch that already fakes the `dev` user. They exist so
 * the job log and package table are reviewable without an Artifactory behind the
 * portal; the logs are copies of what the real code path produced against one.
 *
 * Submitters are mixed on purpose: as a user you see only your own job, as an
 * admin you see all of them and the All/Mine toggle has something to do.
 */
export function devArtifactoryJobs(): ArtifactoryJob[] {
  return [
    {
      id: "ART-0001",
      kind: "folder-upload",
      status: "failed",
      submittedBy: "dev",
      submittedByName: "Dev User",
      createdAt: "2026-08-04T13:14:41.000Z",
      updatedAt: "2026-08-04T13:14:43.000Z",
      name: "node_modules (3 packages)",
      folderName: "node_modules",
      fileCount: 6,
      totalBytes: 224,
      errorMessage: "1 of 3 package(s) failed",
      resultUrl: "https://artifactory.example.com/ui/tree/General/npm-local",
      progress: { done: 3, total: 3 },
      packages: [
        {
          name: "left-pad",
          version: "1.3.0",
          path: "npm-local/left-pad/-/left-pad-1.3.0.tgz",
          status: "uploaded",
          url: "https://artifactory.example.com/ui/tree/General/npm-local/left-pad/-/left-pad-1.3.0.tgz",
        },
        {
          name: "arg",
          version: "4.1.5",
          path: "npm-local/arg/-/arg-4.1.5.tgz",
          status: "exists",
          url: "https://artifactory.example.com/ui/tree/General/npm-local/arg/-/arg-4.1.5.tgz",
        },
        {
          name: "@babel/core",
          version: "7.24.0",
          path: "npm-local/@babel/core/-/core-7.24.0.tgz",
          status: "failed",
          error: "Artifactory responded 403 Forbidden: deploy denied for path",
        },
      ],
      log: [
        "Writing 6 file(s) to temp directory ...",
        "Found 3 package(s).",
        "Checking 3 package(s) against npm-local ...",
        "1 package(s) already in the repo — skipping.",
        "Uploaded left-pad@1.3.0",
        "Failed @babel/core@7.24.0: Artifactory responded 403 Forbidden: deploy denied for path",
        "Done. 1 uploaded, 1 already present, 1 failed.",
      ],
    },
    {
      id: "ART-0002",
      kind: "url-copy",
      status: "completed",
      submittedBy: "u-alex",
      submittedByName: "Alex Morgan",
      createdAt: "2026-08-04T09:02:11.000Z",
      updatedAt: "2026-08-04T09:02:14.000Z",
      name: "arg@4.1.5",
      sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz",
      resultUrl: "https://artifactory.example.com/ui/tree/General/npm-local/arg/-/arg-4.1.5.tgz",
      log: [
        "Fetching https://registry.npmjs.org/arg/-/arg-4.1.5.tgz ...",
        "Uploading to npm-local/arg/-/arg-4.1.5.tgz ...",
        "Done. Artifact available at npm-local/arg/-/arg-4.1.5.tgz.",
      ],
    },
  ];
}
