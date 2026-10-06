import { mkdirSync, readFileSync, readdirSync } from "fs";
import { unlink } from "fs/promises";
import { join } from "path";
import { config } from "../../config";
import { writeJsonAtomic } from "../../jobStore";
import { log } from "../../log";
import type { JenkinsfilePipeline } from "../../types";

/**
 * Saved pipelines, one JSON file per pipeline under `<DATA_DIR>/jenkinsfile`.
 *
 * The AI module's conversation store is the shape this copies
 * (`modules/ai/RealAiApi.ts`): small records, rarely mutated, so every mutation
 * writes the whole thing through and memory holds all of them. `JobStore` is
 * not reusable here — it is `status`/`log`-shaped and splits an in-flight job
 * from a settled one, and a pipeline is never "running".
 *
 * These are user documents, not job history, so `remove` really deletes the
 * file. CLAUDE.md's "nothing is ever deleted" rule is about run history — a
 * pipeline the author threw away has no reason to stay on the volume.
 */
export class PipelineStore {
  private pipelines = new Map<string, JenkinsfilePipeline>();
  private counter = 0;
  private readonly dir: string;

  /** `dataDir` is a parameter purely so tests can point it at a mkdtemp. */
  constructor(dataDir: string = config.dataDir) {
    this.dir = join(dataDir, "jenkinsfile");
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
      let pipeline: JenkinsfilePipeline;
      try {
        pipeline = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as JenkinsfilePipeline;
      } catch (err) {
        // One unreadable file must not stop the process booting.
        log.warn("jenkinsfile", `skipping unreadable pipeline ${file}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!pipeline?.id) continue;
      this.pipelines.set(pipeline.id, pipeline);
      const n = Number(pipeline.id.slice("JF-".length));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
    }
    log.info("jenkinsfile", `loaded ${this.pipelines.size} pipeline(s)`, {
      dir: this.dir,
      nextId: this.counter + 1,
    });
  }

  private save(pipeline: JenkinsfilePipeline) {
    return writeJsonAtomic(join(this.dir, `${pipeline.id}.json`), pipeline).catch((err) =>
      log.error("jenkinsfile", `could not persist ${pipeline.id}`, err)
    );
  }

  nextId(): string {
    return `JF-${String(++this.counter).padStart(4, "0")}`;
  }

  get(id: string): JenkinsfilePipeline | undefined {
    return this.pipelines.get(id);
  }

  /** Newest first, so the list panel matches the other modules' ordering. */
  all(): JenkinsfilePipeline[] {
    return [...this.pipelines.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async put(pipeline: JenkinsfilePipeline): Promise<JenkinsfilePipeline> {
    this.pipelines.set(pipeline.id, pipeline);
    await this.save(pipeline);
    return pipeline;
  }

  async remove(id: string): Promise<void> {
    this.pipelines.delete(id);
    try {
      await unlink(join(this.dir, `${id}.json`));
    } catch (err) {
      // Already gone (double click, hand-deleted file) — the map is what the
      // list serves, and it no longer has it either.
      log.warn("jenkinsfile", `could not delete ${id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
