import type { ArtifactoryJob, PackageUploadResult } from "../../types";

/**
 * Scripted stand-in for a real folder upload. `npm run dev` has no Artifactory
 * behind it, so the Test button replays this instead — same job map, same log,
 * same progress and the same abort controller as a real run, which is what
 * makes the Stop button demonstrable offline.
 *
 * Dev only: the route that starts it is not mounted when SSO is required.
 */
export type SimulationBeat = {
  /** Waited out *before* the beat is applied. */
  ms: number;
  line?: string;
  patch?: Partial<ArtifactoryJob>;
};

const WEB = "https://artifactory.example.com/ui/native/npm-local";

const packages: PackageUploadResult[] = [
  {
    name: "arg",
    version: "4.1.5",
    path: "npm-local/arg/-/arg-4.1.5.tgz",
    status: "exists",
    url: `${WEB}/arg/-/arg-4.1.5.tgz`,
  },
  {
    name: "left-pad",
    version: "1.3.0",
    path: "npm-local/left-pad/-/left-pad-1.3.0.tgz",
    status: "uploaded",
    url: `${WEB}/left-pad/-/left-pad-1.3.0.tgz`,
  },
  {
    name: "@babel/core",
    version: "7.24.0",
    path: "npm-local/@babel/core/-/core-7.24.0.tgz",
    status: "uploaded",
    url: `${WEB}/@babel/core/-/core-7.24.0.tgz`,
  },
];

/** Roughly 11 s end to end — long enough to switch tabs or hit Stop mid-run. */
export const artifactorySimulation: SimulationBeat[] = [
  { ms: 400, patch: { status: "in-progress" } },
  { ms: 600, line: "Writing 6 file(s) to temp directory ..." },
  { ms: 1200, line: "Found 3 package(s).", patch: { name: "node_modules (3 packages)" } },
  { ms: 1200, line: "Checking 3 package(s) against npm-local ..." },
  {
    ms: 1500,
    line: "1 package(s) already in the repo — skipping.",
    patch: { progress: { done: 1, total: 3 }, packages: packages.slice(0, 1) },
  },
  {
    ms: 2500,
    line: "Uploaded left-pad@1.3.0",
    patch: { progress: { done: 2, total: 3 }, packages: packages.slice(0, 2) },
  },
  {
    ms: 3000,
    line: "Uploaded @babel/core@7.24.0",
    patch: { progress: { done: 3, total: 3 }, packages },
  },
  {
    ms: 1200,
    line: "Done. 2 uploaded, 1 already present, 0 failed.",
    patch: { status: "completed", resultUrl: WEB },
  },
];

/** The job the beats are applied to. */
export function simulatedArtifactoryJob(): Partial<ArtifactoryJob> {
  return {
    kind: "folder-upload",
    name: "node_modules",
    folderName: "node_modules",
    fileCount: 6,
    totalBytes: 224,
  };
}
