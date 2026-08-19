import { zip, type AsyncZippable } from "fflate";
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

/**
 * A raw multipart-per-file upload is what makes a node_modules-sized folder
 * drop ~100x slower than dragging a hand-made zip of the same folder — one
 * compressed blob beats tens of thousands of uncompressed multipart parts.
 * fflate's async API keeps this off the UI thread for a big tree.
 */
async function zipEntries(entries: FileEntry[]): Promise<Blob> {
  const inputs: AsyncZippable = {};
  await Promise.all(
    entries.map(async ({ file, path }) => {
      inputs[path] = new Uint8Array(await file.arrayBuffer());
    })
  );
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(inputs, (err, data) => (err ? reject(err) : resolve(data)));
  });
  return new Blob([zipped as BlobPart], { type: "application/zip" });
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
    const startedAt = performance.now();
    try {
      const entries = await collectEntries(entry as FileSystemDirectoryEntry);
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
      const archive = await zipEntries(entries);
      log("artifactory/upload", "scan+zip done", {
        folder: entry.name,
        files: entries.length,
        totalBytes,
        zippedBytes: archive.size,
        ms: Number((performance.now() - startedAt).toFixed(0)),
      });
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
            <span>Preparing folder...</span>
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
