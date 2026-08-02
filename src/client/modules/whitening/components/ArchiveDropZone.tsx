import { FileArchive, Upload, X } from "lucide-react";
import { useState } from "react";
import { log, warn, error as logError } from "../../../log";
import { submitUnpack } from "../api";
import type { WhiteningJob } from "../../../../server/types";

type Props = {
  onSubmitted: (job: WhiteningJob) => void;
  onError: (msg: string) => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArchiveDropZone({ onSubmitted, onError }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (!dropped) return log("whitening/upload", "drop with no files");
    if (!/\.(tgz|tar\.gz)$/i.test(dropped.name)) {
      warn("whitening/upload", "rejected non-tgz drop", { name: dropped.name, type: dropped.type });
      onError("Please drop a .tgz file.");
      return;
    }
    log("whitening/upload", "archive selected", { name: dropped.name, bytes: dropped.size });
    setFile(dropped);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setSubmitting(true);
    const startedAt = performance.now();
    log("whitening/upload", "uploading archive", { name: file.name, bytes: file.size });
    try {
      const result = await submitUnpack(file);
      log("whitening/upload", "accepted", result.job.id, `${(performance.now() - startedAt).toFixed(0)}ms`);
      onSubmitted(result.job);
      setFile(null);
    } catch (err) {
      logError("whitening/upload", "upload failed", file.name, err);
      onError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="art-form" onSubmit={handleSubmit}>
      {!file ? (
        <div
          className={`drop-zone${dragOver ? " drop-zone--over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <FileArchive size={36} aria-hidden="true" />
          <span>Drop a packed .tgz here</span>
          <small>from the whitening packer — must contain repository/config.json</small>
        </div>
      ) : (
        <div className="folder-preview">
          <FileArchive size={24} aria-hidden="true" />
          <div className="folder-preview-info">
            <strong>{file.name}</strong>
            <small>{formatBytes(file.size)}</small>
          </div>
          <button type="button" className="ghost-button" onClick={() => setFile(null)} aria-label="Clear selection">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      <button type="submit" className="primary" disabled={!file || submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? "Unpacking..." : "Unpack & Open PR"}
      </button>
    </form>
  );
}
