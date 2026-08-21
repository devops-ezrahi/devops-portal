import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { log } from "./log";

/** The shape every module's job already has. `log` is the fat field this store keeps off the heap. */
export type StoredJob = {
  id: string;
  status: string;
  updatedAt: string;
  errorMessage?: string;
  log: unknown[];
};

let writeSeq = 0;

/**
 * Write via a unique temp file plus rename, so a crash mid-write cannot leave a
 * torn file that kills the next boot. Callers must not run two of these against
 * one path concurrently — see JobStore.write.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${++writeSeq}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/**
 * Job history on disk, one JSON file per job, with only what is in flight held
 * in memory.
 *
 * The split works because of an invariant all three modules already honour:
 * `patch`, `appendLog` and `aborted` are only ever called on a *running* job —
 * every `cancelJob` returns early on a finished one, and the terminal
 * `patch(status: "completed")` happens while the job is still live. So `get()`
 * can stay synchronous over the live map and no mutation path had to change
 * shape to adopt this.
 *
 * Two writes per job, never one per log line: `add()` when it is created (so a
 * job interrupted by a restart is still on disk to be marked failed) and
 * `settle()` when it ends. Writing on every `appendLog` would rewrite a growing
 * file per subprocess stdout line — quadratic on an artifactory upload.
 *
 * Nothing is ever deleted. If the volume ever fills, delete files on it.
 */
export class JobStore<T extends StoredJob> {
  /** In flight, full object. The synchronous mutation path. */
  private live = new Map<string, T>();
  /**
   * Every job ever. Holds the live object *by reference* while it runs — so a
   * running job's progress shows up in `all()` for free — then `settle()` swaps
   * that reference for a log-free copy. One identity swap, no syncing.
   */
  private index = new Map<string, T>();
  private counter = 0;
  /**
   * Writes run one at a time. `add` and `settle` both write the same job, and
   * `add` snapshots it before the log has filled — overlap them and that stale
   * snapshot can rename itself over the finished one.
   *
   * ponytail: one chain for the whole store, not one per job. Two writes per
   * job of a few KB each; split it per id if a slow volume ever makes this a
   * queue that matters.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private dir: string,
    private prefix: string
  ) {
    mkdirSync(dir, { recursive: true });
    this.hydrate();
  }

  /**
   * ponytail: reads every job file at boot to rebuild the index, which also
   * pulls each log through memory transiently. Fine at hundreds of jobs; if
   * boot ever drags, write an append-only index.jsonl beside them and read
   * that instead.
   */
  private hydrate() {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }

    let interrupted = 0;
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const path = join(this.dir, file);
      let job: T;
      try {
        job = JSON.parse(readFileSync(path, "utf8")) as T;
      } catch (err) {
        // A torn or hand-edited file must not take the process down at boot.
        log.warn("jobStore", `skipping unreadable job file ${file}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!job?.id) continue;

      // Nothing is running yet, so anything still open on disk died with the
      // last process. Without this an AI chat comes back showing a question
      // that never resolves.
      if (!isTerminal(job.status)) {
        job.status = "failed";
        job.errorMessage = "Interrupted by a server restart";
        job.updatedAt = new Date().toISOString();
        try {
          writeFileSync(path, JSON.stringify(job));
        } catch {
          // Read-only volume: the in-memory correction still stands for this run.
        }
        interrupted++;
      }

      this.index.set(job.id, { ...job, log: [] } as T);
      const n = Number(job.id.slice(this.prefix.length + 1));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }

    log.info("jobStore", `loaded ${this.index.size} ${this.prefix} job(s)`, {
      dir: this.dir,
      nextId: this.counter + 1,
      interrupted: interrupted || undefined,
    });
  }

  /** ponytail: pads to 4, so ids stop sorting lexically past 9999. Cosmetic — nothing parses them. */
  nextId(): string {
    return `${this.prefix}-${String(++this.counter).padStart(4, "0")}`;
  }

  /** Live jobs only, synchronously — see the class comment for why that is enough. */
  get(id: string): T | undefined {
    return this.live.get(id);
  }

  /**
   * Record a new job. The returned promise is only there for tests — callers
   * fire and forget, since `settle` rewrites the job when it ends anyway.
   */
  add(job: T): Promise<void> {
    this.live.set(job.id, job);
    this.index.set(job.id, job);
    return this.write(job);
  }

  /** Persist a finished job and drop it from memory, keeping a log-free summary. */
  async settle(id: string): Promise<void> {
    const job = this.live.get(id);
    if (!job) return;
    await this.write(job);
    this.index.set(id, { ...job, log: [] } as T);
    this.live.delete(id);
  }

  /** Full job, log included. Live from memory, finished from disk. */
  async read(id: string): Promise<T | null> {
    const live = this.live.get(id);
    if (live) return live;
    if (!this.index.has(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as T;
    } catch (err) {
      log.warn("jobStore", `could not read ${id}`, { error: err instanceof Error ? err.message : String(err) });
      return this.index.get(id) ?? null;
    }
  }

  /** Every job ever, logs stripped. What the list endpoints serve. */
  all(): T[] {
    return [...this.index.values()];
  }

  private write(job: T): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await writeJsonAtomic(join(this.dir, `${job.id}.json`), job);
      } catch (err) {
        // A job that cannot be persisted must not fail the run that produced it.
        log.error("jobStore", `could not persist ${job.id}`, err);
      }
    });
    return this.queue;
  }
}
