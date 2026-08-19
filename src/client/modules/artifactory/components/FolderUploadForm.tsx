import { AsyncZipDeflate, Zip } from "fflate";
import { FolderOpen, Upload, X } from "lucide-react";
import { useState } from "react";
import { log, warn, error as logError } from "../../../log";
import { submitFolderUpload, type FileEntry } from "../api";
import type { ArtifactoryJob } from "../../../../server/types";

type ScannedFolder = {
  name: string;
  archive: Blob;
  fileCount: number;
  totalBytes: number;
};

/** Mirrors MAX_ARCHIVE_BYTES in server/modules/artifactory/router.ts. */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/** Fold zip output into the Blob this often, so RAM holds a batch, not the archive. */
const BLOB_FLUSH_BYTES = 32 * 1024 * 1024;

/**
 * A raw multipart-per-file upload is what makes a node_modules-sized folder
 * drop ~100x slower than dragging a hand-made zip of the same folder — one
 * compressed blob beats tens of thousands of uncompressed multipart parts.
 *
 * Streamed rather than fflate's one-shot `zip()`: that needs every file's bytes
 * in memory at once and then the whole archive on top, which is roughly 2x the
 * folder — a real node_modules took the tab out. Here one file is read at a
 * time and the output is flushed into a Blob (browser-backed, spillable to
 * disk) as it comes.
 */
export async function zipEntries(
  entries: FileEntry[],
  onProgress: (done: number) => void
): Promise<Blob> {
  const parts: BlobPart[] = [];
  let batch: Uint8Array[] = [];
  let batchBytes = 0;

  let settle!: (err?: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve());
  });

  const zip = new Zip((err, chunk, final) => {
    if (err) return settle(err);
    batch.push(chunk);
    batchBytes += chunk.length;
    if (final || batchBytes >= BLOB_FLUSH_BYTES) {
      parts.push(new Blob(batch as BlobPart[]));
      batch = [];
      batchBytes = 0;
    }
    if (final) settle();
  });

  for (const [index, { file, path }] of entries.entries()) {
    // level 1: node_modules is mostly text, where the cheapest deflate already
    // gets most of the ratio — and the folder can be gigabytes, so CPU per byte
    // is what the user waits on.
    const entry = new AsyncZipDeflate(path, { level: 1 });
    zip.add(entry);
    // Sequential on purpose. Reading the files in parallel puts the whole
    // folder in memory again, which is the bug this shape exists to avoid.
    entry.push(new Uint8Array(await file.arrayBuffer()), true);
    onProgress(index + 1);
  }
  zip.end();
  await finished;

  return new Blob(parts, { type: "application/zip" });
}

type Props = {
  onSubmitted: (job: ArtifactoryJob) => void;
  onError: (msg: string) => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectEntries(dirEntry: FileSystemDirectoryEntry, prefix = ""): Promise<FileEntry[]> {
  const reader = dirEntry.createReader();
  const allChildren: FileSystemEntry[] = [];
  for (;;) {
    const batch: FileSystemEntry[] = await new Promise((resolve) =>
      reader.readEntries(resolve, () => resolve([]))
    );
    if (batch.length === 0) break;
    allChildren.push(...batch);
  }

  const results = await Promise.all(
    allChildren.map(async (child): Promise<FileEntry[]> => {
      if (child.isFile) {
        const fileEntry = child as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) =>
          fileEntry.file(resolve, reject)
        );
        return [{ file, path: prefix + child.name }];
      }
      return collectEntries(child as FileSystemDirectoryEntry, prefix + child.name + "/");
    })
  );

  return results.flat();
}

export function FolderUploadForm({ onSubmitted, onError }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [scannedFolder, setScannedFolder] = useState<ScannedFolder | null>(null);
  const [scanning, setScanning] = useState(false);
  const [zipped, setZipped] = useState({ done: 0, total: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    const item = e.dataTransfer.items[0];
    if (!item) return log("artifactory/upload", "drop with no items");

    const entry = item.webkitGetAsEntry?.();
    if (!entry || !entry.isDirectory) {
      warn("artifactory/upload", "dropped item is not a folder", { name: entry?.name, isDirectory: entry?.isDirectory });
      onError("Please drop a folder, not individual files.");
      return;
    }

    log("artifactory/upload", "scanning folder", entry.name);
    setScanning(true);
    setZipped({ done: 0, total: 0 });
    const startedAt = performance.now();
    try {
      const entries = await collectEntries(entry as FileSystemDirectoryEntry);
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
      setZipped({ done: 0, total: entries.length });
      // Zipping a big tree takes minutes; without a count the drop zone just
      // says "Preparing folder..." and looks hung.
      const archive = await zipEntries(entries, (done) =>
        setZipped((prev) => (done % 50 === 0 || done === entries.length ? { ...prev, done } : prev))
      );
      log("artifactory/upload", "scan+zip done", {
        folder: entry.name,
        files: entries.length,
        totalBytes,
        zippedBytes: archive.size,
        ms: Number((performance.now() - startedAt).toFixed(0)),
      });
      // The server rejects this too, but only after the whole archive has been
      // pushed over the wire — which is a long wait to be told no.
      if (archive.size > MAX_ARCHIVE_BYTES) {
        onError(
          `Zipped folder is ${formatBytes(archive.size)} — over the ${formatBytes(MAX_ARCHIVE_BYTES)} upload limit. Upload it in parts.`
        );
        return;
      }
      setScannedFolder({ name: entry.name, archive, fileCount: entries.length, totalBytes });
    } catch (err) {
      logError("artifactory/upload", "folder scan failed", entry.name, err);
      onError("Failed to read folder contents.");
    } finally {
      setScanning(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scannedFolder) return;
    setSubmitting(true);
    setUploadPercent(0);
    const startedAt = performance.now();
    log("artifactory/upload", "uploading", {
      folder: scannedFolder.name,
      files: scannedFolder.fileCount,
      totalBytes: scannedFolder.totalBytes,
      zippedBytes: scannedFolder.archive.size,
    });
    try {
      const result = await submitFolderUpload(
        scannedFolder.name,
        scannedFolder.archive,
        scannedFolder.fileCount,
        scannedFolder.totalBytes,
        setUploadPercent
      );
      log("artifactory/upload", "accepted", result.job.id, `${(performance.now() - startedAt).toFixed(0)}ms`);
      onSubmitted(result.job);
      setScannedFolder(null);
    } catch (err) {
      logError("artifactory/upload", "upload failed", scannedFolder.name, err);
      onError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="art-form" onSubmit={handleSubmit}>
      {!scannedFolder ? (
        <div
          className={`drop-zone${dragOver ? " drop-zone--over" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <FolderOpen size={36} aria-hidden="true" />
          {scanning ? (
            <span>
              Preparing folder...
              {zipped.total > 0 && ` ${zipped.done.toLocaleString()} / ${zipped.total.toLocaleString()} files`}
            </span>
          ) : (
            <>
              <span>Drop a folder here</span>
              <small>
                e.g. node_modules, a ~/.m2/repository tree, or a folder of .rpm / .whl / .conda files
              </small>
            </>
          )}
        </div>
      ) : (
        <div className="folder-preview">
          <FolderOpen size={24} aria-hidden="true" />
          <div className="folder-preview-info">
            <strong>{scannedFolder.name}</strong>
            <small>
              {scannedFolder.fileCount.toLocaleString()} files &middot;{" "}
              {formatBytes(scannedFolder.totalBytes)}
            </small>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setScannedFolder(null)}
            aria-label="Clear selection"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {submitting && (
        <progress className="job-progress" value={uploadPercent} max={100} />
      )}

      <button type="submit" className="primary" disabled={!scannedFolder || submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? `Uploading... ${uploadPercent}%` : "Upload to Artifactory"}
      </button>
    </form>
  );
}
