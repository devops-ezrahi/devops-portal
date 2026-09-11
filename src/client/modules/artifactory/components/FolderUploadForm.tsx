import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { FolderOpen, Upload, X } from "lucide-react";
import { useState } from "react";
import { Help } from "../../../Help";
import { log, warn, error as logError } from "../../../log";
import { beginFolderUpload, completeFolderUpload, uploadArchivePart, type FileEntry } from "../api";
import type { ArtifactoryJob } from "../../../../server/types";

type ScannedFolder = {
  /** The dropped folder's name, a single file's name, or "N items". */
  name: string;
  entries: FileEntry[];
  totalBytes: number;
};

/** Mirrors MAX_ARCHIVE_BYTES in server/modules/artifactory/router.ts. */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/**
 * Already-compressed formats — stored verbatim instead of deflated. Measured on
 * 40MB of gzip: deflate level 1 gives a 100.0% ratio at 21 MB/s, i.e. it spends
 * the whole wait to save nothing. Most of what this form takes (a folder of
 * .tgz / .whl / .rpm / .conda, an ~/.m2 tree of jars) is exactly this.
 */
const STORED = /\.(tgz|gz|zip|jar|war|whl|rpm|conda|bz2|xz|zst|7z|png|jpe?g|gif|webp|avif|woff2?|mp4|mp3)$/i;

/**
 * Cut a part every 8 MB. Small enough that the first one is on the wire seconds
 * after the button is pressed and progress moves visibly; large enough that a
 * request's own overhead is noise beside the bytes it carries.
 */
const PART_BYTES = 8 * 1024 * 1024;

/**
 * Parts on the wire at once. One was a stop-and-wait protocol: the zip loop
 * halted for a whole round trip per part, so the CPU and the network took turns
 * instead of overlapping — invisible over localhost, and most of the wait once a
 * cluster router and an auth proxy sit in between. Three keeps the pipe full
 * without putting the folder back in memory: at most MAX_INFLIGHT * PART_BYTES
 * (24 MB) is held, which is the whole reason this shape exists.
 */
const MAX_INFLIGHT = 3;

/**
 * Where the wall clock went. A slow upload has three candidate causes — reading
 * the files, compressing them, and the network — and no way to tell them apart
 * from the outside, which is how this path came to be optimised three times by
 * guess. `handleSubmit` logs the split and shows the rate on the page.
 */
export type ZipStats = { readMs: number; zipMs: number; blockedMs: number; bytes: number };

/**
 * A raw multipart-per-file upload is what makes a node_modules-sized folder
 * drop ~100x slower than dragging a hand-made zip of the same folder — one
 * compressed blob beats tens of thousands of uncompressed multipart parts.
 *
 * Streamed rather than fflate's one-shot `zip()`: that needs every file's bytes
 * in memory at once and then the whole archive on top, which is roughly 2x the
 * folder — a real node_modules took the tab out. Here one file is read at a
 * time and each finished part is handed to `onPart` and dropped, so the archive
 * never exists in the tab as a whole and the network runs while the next files
 * compress. A slow connection cannot let the zip run ahead into memory either:
 * `MAX_INFLIGHT` parts is the ceiling, and the loop blocks once it is reached.
 */
export async function zipEntries(
  entries: FileEntry[],
  onProgress: (done: number, stats: ZipStats) => void,
  onPart: (part: Blob, offset: number) => Promise<void>
): Promise<ZipStats> {
  const ready: Blob[] = [];
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const stats: ZipStats = { readMs: 0, zipMs: 0, blockedMs: 0, bytes: 0 };

  let settle!: (err?: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve());
  });

  const zip = new Zip((err, chunk, final) => {
    if (err) return settle(err);
    batch.push(chunk);
    batchBytes += chunk.length;
    if (final || batchBytes >= PART_BYTES) {
      ready.push(new Blob(batch as BlobPart[]));
      batch = [];
      batchBytes = 0;
    }
    if (final) settle();
  });

  // Up to MAX_INFLIGHT parts in flight. The offset is assigned here,
  // synchronously, before any await — two concurrent parts must never claim the
  // same one — and the server writes each part at the offset it is given rather
  // than appending, so the order they arrive in stops mattering.
  //
  // A rejection is parked in `failure` rather than left on the promise: these
  // are raced, not awaited in order, and an uncaught one would surface as an
  // `unhandledrejection` instead of failing the submit. The loops below check it
  // every pass, so a bad part stops the run at the file it happened on rather
  // than after the other 19,999 have been compressed for nothing.
  const inflight = new Set<Promise<void>>();
  let offset = 0;
  let failure: unknown;

  const send = async () => {
    while (ready.length > 0 && failure === undefined) {
      if (inflight.size >= MAX_INFLIGHT) {
        // The only place this loop waits on the network, so it is the only thing
        // `blockedMs` measures: the zip having to slow down to the wire's pace.
        const from = performance.now();
        await Promise.race(inflight);
        stats.blockedMs += performance.now() - from;
      }
      const part = ready.shift()!;
      const at = offset;
      offset += part.size;
      const promise: Promise<void> = onPart(part, at)
        .catch((err: unknown) => {
          failure ??= err;
        })
        .finally(() => inflight.delete(promise));
      inflight.add(promise);
    }
  };

  // Read one file ahead: the read is I/O and the deflate is CPU, so overlapping
  // the two hides whichever is shorter. Depth 1 on purpose — reading the whole
  // list in parallel puts the folder back in memory, which is the bug this
  // shape exists to avoid.
  let pending = entries[0]?.file.arrayBuffer();

  for (const [index, { path }] of entries.entries()) {
    if (failure !== undefined) throw failure;

    const readFrom = performance.now();
    const bytes = new Uint8Array(await pending!);
    stats.readMs += performance.now() - readFrom;
    pending = entries[index + 1]?.file.arrayBuffer();

    // level 1: node_modules is mostly text, where the cheapest deflate already
    // gets most of the ratio — and the folder can be gigabytes, so CPU per byte
    // is what the user waits on.
    //
    // ZipDeflate, not AsyncZipDeflate: the async one spawns a *Worker per
    // entry* (fflate's `astrmify`), which for a folder of thousands of small
    // files costs far more than the deflate it moves off-thread — 3,000 files
    // measured at 47.8s async vs 0.41s sync. The UI still repaints, because
    // the `await` above yields between files.
    const zipFrom = performance.now();
    const entry = STORED.test(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 1 });
    zip.add(entry);
    entry.push(bytes, true);
    stats.zipMs += performance.now() - zipFrom;

    onProgress(index + 1, stats);
    await send();
  }
  zip.end();
  await finished;
  await send();
  await Promise.all(inflight);
  if (failure !== undefined) throw failure;

  stats.bytes = offset;
  return stats;
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
  // `bytes` counts parts that actually landed, not the offset reached: parts are
  // in flight together now, so the furthest one dispatched is not what has been
  // confirmed. `mbPerSec` and `zipPercent` are the diagnostic the log line
  // carries, put on the page because prod needs `localStorage.portalDebug` set
  // before a console line appears and a slow upload is reported, not devtooled.
  const [sent, setSent] = useState({ files: 0, bytes: 0, mbPerSec: 0, zipPercent: 0 });

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

    // Read every entry out of the DataTransfer *before* the first await: the
    // list is emptied as soon as the drop event handler returns.
    const roots = [...e.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry);
    if (roots.length === 0) return log("artifactory/upload", "drop with no items");

    const name = roots.length === 1 ? roots[0].name : `${roots.length} items`;
    log("artifactory/upload", "scanning drop", { name, roots: roots.length });
    setScanning(true);
    const startedAt = performance.now();
    try {
      // Only the file handles are collected here. Nothing is read and nothing is
      // compressed until the button is pressed, so the drop is over in about as
      // long as it takes to walk the tree.
      //
      // A lone folder keeps its contents at the root of the archive, which is
      // what the Maven layout check reads; several roots each keep their own
      // name, or two dropped trees would overwrite each other's files.
      const collected = await Promise.all(
        roots.map(async (entry): Promise<FileEntry[]> => {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) =>
              (entry as FileSystemFileEntry).file(resolve, reject)
            );
            return [{ file, path: entry.name }];
          }
          const prefix = roots.length > 1 ? `${entry.name}/` : "";
          return collectEntries(entry as FileSystemDirectoryEntry, prefix);
        })
      );
      const entries = collected.flat();
      if (entries.length === 0) {
        warn("artifactory/upload", "drop held no files", { name });
        onError("Nothing to upload — that folder is empty.");
        return;
      }
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
      log("artifactory/upload", "scan done", {
        name,
        files: entries.length,
        totalBytes,
        ms: Number((performance.now() - startedAt).toFixed(0)),
      });
      setScannedFolder({ name, entries, totalBytes });
    } catch (err) {
      logError("artifactory/upload", "scan failed", name, err);
      onError("Failed to read what was dropped.");
    } finally {
      setScanning(false);
    }
  }

  /** The click-through for the same thing: a browser file picker takes files only. */
  function handlePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    // Let the same file be picked again after clearing the selection.
    e.target.value = "";
    if (files.length === 0) return;
    const entries = files.map((file) => ({ file, path: file.name }));
    log("artifactory/upload", "picked files", { files: entries.length });
    setScannedFolder({
      name: files.length === 1 ? files[0].name : `${files.length} files`,
      entries,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scannedFolder) return;
    const { name, entries, totalBytes } = scannedFolder;
    setSubmitting(true);
    setSent({ files: 0, bytes: 0, mbPerSec: 0, zipPercent: 0 });
    const startedAt = performance.now();
    log("artifactory/upload", "uploading", { folder: name, files: entries.length, totalBytes });

    try {
      const { uploadId } = await beginFolderUpload();

      const stats = await zipEntries(
        entries,
        // Repainting on every file of a 20k-file folder is its own bottleneck.
        (files, running) => {
          if (files % 50 !== 0 && files !== entries.length) return;
          const busy = running.readMs + running.zipMs + running.blockedMs;
          setSent((prev) => ({
            ...prev,
            files,
            zipPercent: busy > 0 ? Math.round(((running.readMs + running.zipMs) / busy) * 100) : 0,
          }));
        },
        async (part, at) => {
          // The server enforces this too, but only by cutting the connection
          // mid-part, which reaches the user as a dead socket rather than a
          // sentence. Stopping here is what makes it a message.
          if (at + part.size > MAX_ARCHIVE_BYTES) {
            throw new Error(
              `Zipped folder is over the ${formatBytes(MAX_ARCHIVE_BYTES)} upload limit. Upload it in parts.`
            );
          }
          await uploadArchivePart(uploadId, at, part);
          setSent((prev) => {
            const bytes = prev.bytes + part.size;
            const secs = (performance.now() - startedAt) / 1000;
            return { ...prev, bytes, mbPerSec: secs > 0 ? bytes / 1024 / 1024 / secs : 0 };
          });
        }
      );

      const { job } = await completeFolderUpload({
        uploadId,
        folderName: name,
        fileCount: entries.length,
        totalBytes,
        archiveBytes: stats.bytes,
      });
      const ms = performance.now() - startedAt;
      // The whole split, in one line: reading the files, compressing them, and
      // waiting on the wire. Which of the three dominates is the only thing that
      // says what to fix next, and it is not guessable from the outside.
      log("artifactory/upload", "accepted", job.id, {
        zippedBytes: stats.bytes,
        ms: Number(ms.toFixed(0)),
        readMs: Number(stats.readMs.toFixed(0)),
        zipMs: Number(stats.zipMs.toFixed(0)),
        blockedMs: Number(stats.blockedMs.toFixed(0)),
        mbPerSec: Number((stats.bytes / 1024 / 1024 / (ms / 1000)).toFixed(2)),
      });
      onSubmitted(job);
      setScannedFolder(null);
    } catch (err) {
      logError("artifactory/upload", "upload failed", name, err);
      onError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  const percent = scannedFolder && scannedFolder.entries.length > 0
    ? Math.round((sent.files / scannedFolder.entries.length) * 100)
    : 0;

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
              <span>
                Drop a folder or files here{" "}
                <Help label="what can be dropped">
                  <p>
                    A <code>node_modules</code>, a <code>~/.m2/repository</code> tree or a flat folder of jars.
                  </p>
                  <p>
                    Or any number of loose <code>.tgz</code> / <code>.jar</code> / <code>.whl</code> /{" "}
                    <code>.rpm</code> / <code>.conda</code> files.
                  </p>
                </Help>
              </span>
              <label className="ghost-button file-picker">
                Choose files
                <input type="file" multiple onChange={handlePicked} />
              </label>
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
        <>
          <progress className="job-progress" value={percent} max={100} />
          <small className="upload-status">
            {sent.files.toLocaleString()} / {scannedFolder!.entries.length.toLocaleString()} files
            &middot; {formatBytes(sent.bytes)} sent
            {sent.mbPerSec > 0 && ` · ${sent.mbPerSec.toFixed(1)} MB/s`}
            {sent.bytes > 0 && ` · zip ${sent.zipPercent}% / net ${100 - sent.zipPercent}%`}
          </small>
        </>
      )}

      <button type="submit" className="primary" disabled={!scannedFolder || submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? `Uploading... ${percent}%` : "Upload to Artifactory"}
      </button>
    </form>
  );
}
