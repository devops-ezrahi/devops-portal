import { randomUUID } from "crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/** Prefixes this app owns under the OS temp dir. Only these are ever swept. */
const JOB_PREFIXES = ["art-", "wht-"];

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Create a private working directory for one job. Caller must `removeTmpDir` it. */
export function createTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Create a job dir under a name the *client* can hold onto. `createTmpDir` hands
 * back a path only the current request knows, which is no use to an upload that
 * arrives as a series of requests and has to find the same dir again each time.
 * The name is therefore the id, and it is a UUID because holding it is what
 * grants the right to append to that upload. The prefix keeps it in reach of
 * `sweepOldTmpDirs`, which is the only cleanup an abandoned upload gets.
 */
export async function createNamedTmpDir(prefix: string): Promise<string> {
  const name = `${prefix}${randomUUID()}`;
  await mkdir(join(tmpdir(), name));
  return name;
}

/** Resolve a name from `createNamedTmpDir` back to its path. Validate it first. */
export function tmpDirByName(name: string): string {
  return join(tmpdir(), name);
}

/**
 * Delete a job's working directory. Never throws: this runs in `finally` blocks,
 * where a rejection would escape as an unhandled rejection and take down the
 * process over a leftover file. Windows also holds locks on a freshly cloned
 * `.git`, hence the retries.
 */
export async function removeTmpDir(dir: string, onError: (message: string) => void = () => {}) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    onError(`Warning: could not remove temp dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Drop job temp dirs older than 24h. `finally` cleanup covers every path a job
 * can finish on, but not a crash or restart mid-job — this is the only thing
 * that reclaims those. Fire-and-forget at boot.
 */
export async function sweepOldTmpDirs(now = Date.now()) {
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!JOB_PREFIXES.some((p) => entry.startsWith(p))) continue;
    const path = join(tmpdir(), entry);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || now - info.mtimeMs < MAX_AGE_MS) continue;
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Another process's dir, or already gone. Not our problem.
    }
  }
}
