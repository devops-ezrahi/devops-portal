import { mkdirSync, readFileSync, readdirSync } from "fs";
import { unlink } from "fs/promises";
import { join } from "path";
import { config } from "../../config";
import { writeJsonAtomic } from "../../jobStore";
import { log } from "../../log";
import type { ArgocdTree } from "../../types";

/**
 * Saved GitOps trees, one JSON file per tree under `<DATA_DIR>/argocd`.
 *
 * `PipelineStore` in miniature — same reasons, same shape: small records,
 * rarely mutated, so every mutation writes the whole thing through and memory
 * holds all of them. `JobStore` is `status`/`log`-shaped and a tree never runs.
 *
 * These are user documents, so `remove` really deletes.
 */
export class TreeStore {
  private trees = new Map<string, ArgocdTree>();
  private counter = 0;
  private readonly dir: string;

  /** `dataDir` is a parameter purely so tests can point it at a mkdtemp. */
  constructor(dataDir: string = config.dataDir) {
    this.dir = join(dataDir, "argocd");
    this.load();
  }

  private load() {
    mkdirSync(this.dir, { recursive: true });
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      let tree: ArgocdTree;
      try {
        tree = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as ArgocdTree;
      } catch (err) {
        // One unreadable file must not stop the process booting.
        log.warn("argocd", `skipping unreadable tree ${file}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!tree?.id) continue;
      this.trees.set(tree.id, tree);
      const n = Number(tree.id.slice("AG-".length));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
    log.info("argocd", `loaded ${this.trees.size} tree(s)`, { dir: this.dir, nextId: this.counter + 1 });
  }

  private save(tree: ArgocdTree) {
    return writeJsonAtomic(join(this.dir, `${tree.id}.json`), tree).catch((err) =>
      log.error("argocd", `could not persist ${tree.id}`, err)
    );
  }

  nextId(): string {
    return `AG-${String(++this.counter).padStart(4, "0")}`;
  }

  get(id: string): ArgocdTree | undefined {
    return this.trees.get(id);
  }

  /** Newest first, so the list panel matches the other modules' ordering. */
  all(): ArgocdTree[] {
    return [...this.trees.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async put(tree: ArgocdTree): Promise<ArgocdTree> {
    this.trees.set(tree.id, tree);
    await this.save(tree);
    return tree;
  }

  async remove(id: string): Promise<void> {
    this.trees.delete(id);
    try {
      await unlink(join(this.dir, `${id}.json`));
    } catch (err) {
      // Already gone (double click, hand-deleted file) — the map is what the
      // list serves, and it no longer has it either.
      log.warn("argocd", `could not delete ${id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
