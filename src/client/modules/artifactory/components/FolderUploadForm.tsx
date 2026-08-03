import { FolderOpen, Upload, X } from "lucide-react";
import { useState } from "react";
import { log, warn, error as logError } from "../../../log";
import { submitFolderUpload, type FileEntry } from "../api";
import type { ArtifactoryJob } from "../../../../server/types";

type ScannedFolder = {
  name: string;
  entries: FileEntry[];
  totalBytes: number;
};

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
      log("artifactory/upload", "scan done", {
        folder: entry.name,
        files: entries.length,
        totalBytes,
        ms: Number((performance.now() - startedAt).toFixed(0)),
      });
      setScannedFolder({ name: entry.name, entries, totalBytes });
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
      files: scannedFolder.entries.length,
      totalBytes: scannedFolder.totalBytes,
    });
    try {
      const result = await submitFolderUpload(scannedFolder.name, scannedFolder.entries, setUploadPercent);
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
            <span>Scanning folder...</span>
          ) : (
            <>
              <span>Drop a folder here</span>
              <small>e.g. node_modules or any local package directory</small>
            </>
          )}
        </div>
      ) : (
        <div className="folder-preview">
          <FolderOpen size={24} aria-hidden="true" />
          <div className="folder-preview-info">
            <strong>{scannedFolder.name}</strong>
            <small>
              {scannedFolder.entries.length.toLocaleString()} files &middot;{" "}
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
