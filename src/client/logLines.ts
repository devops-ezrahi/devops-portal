/**
 * Shared classifier for job log lines. Both upload logs (Artifactory's flat
 * `string[]` and Whitening's step-grouped entries) carry the per-package
 * outcomes that `npmPackages.packAndUpload` writes, so the "this package is
 * done" lines look the same in both places.
 *
 * Matching on text keeps the server's log a plain list of strings — the shape
 * the API already returns.
 */
export type LogLine = {
  /** "" for ordinary lines, so callers can concatenate without a guard. */
  className: string;
  /** Pulled out of the line so the package it refers to reads as a heading. */
  pkg?: string;
  /** The line minus the package name; empty when the name said it all. */
  text: string;
  badge?: string;
};

export function classifyLogLine(line: string): LogLine {
  const uploaded = /^Uploaded (\S+)$/.exec(line);
  if (uploaded) return { className: "log-uploaded", pkg: uploaded[1], text: "", badge: "Uploaded" };

  const failed = /^Failed (\S+?):\s*(.+)$/.exec(line);
  if (failed) return { className: "log-failed", pkg: failed[1], text: failed[2], badge: "Failed" };

  if (/already (exists|in the repo)/.test(line)) {
    return { className: "log-skipped", text: line, badge: "Skipped" };
  }

  if (/^Done\./.test(line)) return { className: "log-summary", text: line };

  return { className: "", text: line };
}
