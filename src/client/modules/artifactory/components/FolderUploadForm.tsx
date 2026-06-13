import { FolderOpen, Upload, X } from "lucide-react";
import { useState } from "react";
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
    if (!item) return;

    const entry = item.webkitGetAsEntry?.();
    if (!entry || !entry.isDirectory) {
      onError("Please drop a folder, not individual files.");
      return;
    }

    setScanning(true);
    try {
      const entries = await collectEntries(entry as FileSystemDirectoryEntry);
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
      setScannedFolder({ name: entry.name, entries, totalBytes });
    } catch {
      onError("Failed to read folder contents.");
    } finally {
      setScanning(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scannedFolder) return;
    setSubmitting(true);
    try {
      const result = await submitFolderUpload(scannedFolder.name, scannedFolder.entries);
      onSubmitted(result.job);
      setScannedFolder(null);
    } catch (err) {
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

      <button type="submit" className="primary" disabled={!scannedFolder || submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? "Uploading..." : "Upload to Artifactory"}
      </button>
    </form>
  );
}
