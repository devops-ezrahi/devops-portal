import { execFile } from "child_process";
import { createWriteStream } from "fs";
import { mkdir, readFile, readdir } from "fs/promises";
import { basename, dirname, join, relative } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
// Rejects on abort, so a cancelled simulation stops mid-sleep instead of at the
// end of the current beat.
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import { config } from "../../config";
import { JobStore } from "../../jobStore";
import { log, userMessage } from "../../log";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { webUrl } from "./artifactoryRest";
import { artifactorySimulation, simulatedArtifactoryJob } from "./devSimulation";
import {
  MAX_DEPENDENCY_PACKAGES,
  npmIdentityFromUrl,
  npmRegistryFromUrl,
  resolveNpmDependencies,
  sourceTokenFor,
} from "./npmDependencies";
import {
  discoverPackages,
  jobName,
  npmUploadItems,
  pool,
  targetPath,
  uniquePackages,
  uploadFiles,
} from "./npmPackages";
import {
  classify,
  downloadUrl,
  helmTargetPath,
  mavenCoordsFromPom,
  mavenLayoutPath,
  mavenPomUrl,
  mavenRootDepth,
  urlArtifactPath,
} from "./packageTypes";
import type { MavenCoords } from "./packageTypes";
import {
  mavenRepoFromUrl,
  pypiIndexFromUrl,
  resolveMavenDependencies,
  resolvePypiDependencies,
} from "./toolDependencies";
import type { UploadItem } from "./npmPackages";
import type {
  ArtifactoryApi,
  ArtifactoryJob,
  ArtifactoryScenario,
  FolderUploadInput,
  PackageUploadResult,
  PortalUser,
  UrlCopyInput,
} from "../../types";

const execFileAsync = promisify(execFile);

/**
 * How many loose files to sniff at once. Each one is a short-lived `tar` or
 * `unzip`, so this is bounded by process spawn cost, not by the pod's CPU.
 *
 * ponytail: an informed guess, like the upload pools next door. Tune it if a
 * huge drop still crawls.
 */
const SNIFF_CONCURRENCY = 16;

function nowIso() {
  return new Date().toISOString();
}

/**
 * `originalname` is the browser-supplied relative path. It is joined onto a temp
 * dir and then onto the Artifactory target, so a `..` segment would write and
 * publish outside both.
 */
function safeRelativePath(name: string): string {
  const normalised = name.replace(/\\/g, "/");
  const segments = normalised.split("/").filter(Boolean);
  if (
    normalised.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalised) ||
    segments.some((s) => s === ".." || s === ".")
  ) {
    throw new Error(`Rejected unsafe path in upload: ${name}`);
  }
  return segments.join("/");
}

/** Every file under `root`, as forward-slash paths relative to `root`. */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return out;
}

/**
 * The prefix a dropped Maven tree sits under, `""` when it is already at the
 * root of the drop. Stripping it is what keeps a groupId from picking up the
 * folders above the tree: `m2/org/apache/commons/...` otherwise deploys as
 * groupId `m2.org.apache.commons`, a path nothing resolves from and one
 * Artifactory answers with a 409 when the pom disagrees with it.
 *
 * Learned from the first pom whose own coordinates line up with where it sits —
 * the pom says the group, the path says where it is, and the difference is the
 * prefix. One prefix for the whole drop: an `~/.m2/repository` has one root.
 * With no pom in the drop there is nothing to learn from and the path is taken
 * as-is, exactly as before.
 */
async function mavenTreePrefix(sourceDir: string, relPaths: string[]): Promise<string> {
  for (const path of relPaths) {
    if (!path.toLowerCase().endsWith(".pom")) continue;
    let coords;
    try {
      coords = mavenCoordsFromPom(await readFile(join(sourceDir, path), "utf8"));
    } catch {
      continue;
    }
    if (!coords) continue;
    const depth = mavenRootDepth(path, coords);
    // A pom that disagrees with its own path teaches nothing — keep looking.
    if (depth === null) continue;
    return path.split("/").slice(0, depth).join("/");
  }
  return "";
}

export class RealArtifactoryApi implements ArtifactoryApi {
  private readonly jobs: JobStore<ArtifactoryJob>;
  /** One per running job, so `cancelJob` can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();

  /** `dataDir` is a parameter purely so tests can point it at a mkdtemp. */
  constructor(dataDir: string = config.dataDir) {
    this.jobs = new JobStore<ArtifactoryJob>(join(dataDir, "artifactory"), "ART");
  }

  private patch(jobId: string, updates: Partial<ArtifactoryJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, { ...updates, updatedAt: nowIso() });
  }

  // Every line the user sees in the job drawer is also a pod-log line, tagged
  // with the job id. That is the whole point of these logs: a support request
  // is "ART-0007 failed", and `kubectl logs | grep ART-0007` has to answer it.
  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.log.push(redactSecrets(line));
    job.updatedAt = nowIso();
    log.info(`artifactory ${jobId}`, line);
  }

  /**
   * The tree was asked for and not copied. Says so on the job as well as in the
   * log: the fallback is deliberately not a failed job, so a "Completed" run
   * whose only trace of it was one line among fifty read as a dependency copy
   * that worked. `hint` is a next step, not a reason, so it trails the sentence.
   */
  private dependencyFallback(jobId: string, reason: string, hint?: string) {
    this.patch(jobId, { dependencyFallback: hint ? `${reason}. ${hint}` : reason });
    this.appendLog(jobId, `${reason} — copying the single artifact.${hint ? ` ${hint}` : ""}`);
  }

  /**
   * True once the user has stopped the job. Every run's `catch` and `finish`
   * consults it: the AbortError the cancel *caused* must not relabel an
   * aborted job as failed.
   */
  private aborted(jobId: string): boolean {
    return this.jobs.get(jobId)?.status === "aborted";
  }

  private start(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller.signal;
  }

  async submitUrlCopy(input: UrlCopyInput, submitter: PortalUser): Promise<ArtifactoryJob> {
    // People paste what Artifactory's own UI put in their address bar — which
    // serves a web page, not the artifact. Normalised once here rather than at
    // the fetch, so the job records the URL everything downstream actually
    // used: classify, the npm registry, the sibling pom and the log all read it.
    input = { ...input, sourceUrl: downloadUrl(input.sourceUrl) };
    const job: ArtifactoryJob = {
      id: this.jobs.nextId(),
      kind: "url-copy",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sourceUrl: input.sourceUrl,
      includeDependencies: input.includeDependencies || undefined,
      log: [],
    };
    this.jobs.add(job);
    log.info("artifactory", `${job.id} url-copy submitted`, {
      by: submitter.id,
      source: input.sourceUrl,
      deps: !!input.includeDependencies,
      jobs: this.jobs.all().length,
    });
    void this.runUrlCopy(job.id, input);
    return job;
  }

  async submitFolderUpload(input: FolderUploadInput, submitter: PortalUser): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.jobs.nextId(),
      kind: "folder-upload",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      name: input.folderName,
      folderName: input.folderName,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      log: [],
    };
    this.jobs.add(job);
    log.info("artifactory", `${job.id} folder-upload submitted`, {
      by: submitter.id,
      folder: input.folderName,
      files: input.fileCount,
      bytes: input.totalBytes,
      archive: input.archivePath,
      jobs: this.jobs.all().length,
    });
    void this.runFolderUpload(job.id, input);
    return job;
  }

  async simulate(submitter: PortalUser, scenario: ArtifactoryScenario = "npm"): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.jobs.nextId(),
      kind: "folder-upload",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      ...simulatedArtifactoryJob(scenario),
    };
    this.jobs.add(job);
    void this.runSimulation(job.id, scenario);
    return job;
  }

  private async runSimulation(jobId: string, scenario: ArtifactoryScenario) {
    const signal = this.start(jobId);
    try {
      for (const beat of artifactorySimulation(scenario)) {
        await sleep(beat.ms, undefined, { signal });
        if (beat.patch) this.patch(jobId, beat.patch);
        if (beat.line) this.appendLog(jobId, beat.line);
      }
    } catch {
      // Only sleep() rejects here, and only because the job was cancelled.
    } finally {
      this.controllers.delete(jobId);
      await this.jobs.settle(jobId);
    }
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<ArtifactoryJob[]> {
    // Logs are stripped here — the drawer fetches the full job by id.
    return this.jobs
      .all()
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<ArtifactoryJob | null> {
    return this.jobs.read(jobId);
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<ArtifactoryJob | null> {
    // Live first, disk second: cancelling a job that just finished returns it
    // rather than 404ing, which is what it did while everything was in memory.
    const job = this.jobs.get(jobId) ?? (await this.jobs.read(jobId));
    if (!job) return null;
    if (!allUsers && job.submittedBy !== user.id) {
      throw new Error("Forbidden: not your job");
    }
    // Finished is finished — a late Stop must not rewrite history.
    if (job.status !== "pending" && job.status !== "in-progress") return job;

    this.patch(jobId, { status: "aborted", errorMessage: undefined });
    this.appendLog(jobId, `Aborted by ${user.displayName}.`);
    this.controllers.get(jobId)?.abort();
    return job;
  }

  /** Job is failed if anything failed, but the successes are still reported. */
  private finish(jobId: string, results: PackageUploadResult[]) {
    if (this.aborted(jobId)) return;
    const failures = results.filter((r) => r.status === "failed");
    const uploaded = results.filter((r) => r.status === "uploaded").length;
    const skipped = results.filter((r) => r.status === "exists").length;

    this.patch(jobId, {
      packages: results,
      status: failures.length > 0 ? "failed" : "completed",
      errorMessage:
        failures.length > 0 ? `${failures.length} of ${results.length} package(s) failed` : undefined,
      // For many packages, link the repo they went to — which is no longer always
      // the npm one, so take it from the first target rather than from config.
      resultUrl:
        results.length === 1
          ? results[0].url
          : webUrl(results[0]?.path.split("/")[0] ?? config.artifactory.repo),
    });
    this.appendLog(
      jobId,
      `Done. ${uploaded} uploaded, ${skipped} already present, ${failures.length} failed.`
    );
  }

  private async runUrlCopy(jobId: string, input: UrlCopyInput) {
    const signal = this.start(jobId);
    const tmpDir = await createTmpDir("art-");
    try {
      this.patch(jobId, { status: "in-progress" });
      this.appendLog(jobId, `Fetching ${input.sourceUrl} ...`);

      const res = await fetch(input.sourceUrl, { signal });
      if (!res.ok) {
        throw new Error(`Source responded with ${res.status} ${res.statusText}`);
      }
      if (!res.body) throw new Error("Source returned an empty body");

      const filename = new URL(input.sourceUrl).pathname.split("/").filter(Boolean).pop();
      if (!filename) throw new Error("Cannot determine filename from source URL");

      // Streamed, not buffered: an artifact is routinely hundreds of MB, and
      // `arrayBuffer()` would hold all of it in the heap on the way to disk.
      const tmpFile = join(tmpDir, safeRelativePath(filename));
      // fetch hands back the DOM stream type; Readable.fromWeb wants node's.
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(tmpFile),
        { signal }
      );

      // The tarball sniff reads the file itself, so it wins over any path guess.
      const sniffed = await readTarballIdentity(tmpFile);
      // A .tgz whose manifest could not be read still has the registry layout in
      // its own URL. Without this, `@octokit/types/-/types-16.0.0.tgz` fell all
      // the way through to "unrecognised artifact" and was uploaded flat, scope
      // and all, under the bare name `types-16.0.0.tgz`.
      const fromUrl = sniffed ? null : npmIdentityFromUrl(input.sourceUrl);
      if (fromUrl) {
        this.appendLog(
          jobId,
          `No manifest inside the tarball — taking ${fromUrl.name}@${fromUrl.version} from the registry URL.`
        );
      }
      const identity: TarballIdentity | null = sniffed ?? (fromUrl ? { type: "npm", ...fromUrl } : null);
      const classified = identity
        ? null
        : classify(urlArtifactPath(input.sourceUrl), (line) => this.appendLog(jobId, line));

      let items: UploadItem[];
      if (identity) {
        const root = tarballUploadItem(identity, tmpFile, (line) => this.appendLog(jobId, line));
        if (!root) {
          throw new Error(
            `${identity.name}@${identity.version} is a ${identity.type} package, but ` +
              `ARTIFACTORY_${identity.type.toUpperCase()}_REPO is not set — nothing was uploaded.`
          );
        }
        this.appendLog(jobId, `Detected a ${identity.type} artifact.`);
        this.patch(jobId, { name: `${identity.name}@${identity.version}` });
        // Helm charts carry their dependencies inside the chart (charts/), so
        // there is no tree to resolve; the note below says so.
        const deps =
          input.includeDependencies && identity.type === "npm"
            ? await this.resolveDependencies(jobId, input.sourceUrl, identity, tmpDir, signal)
            : [];
        // Root last on purpose: uploadFiles dedupes by path keeping the *last*
        // entry, and the root's repacked copy out of node_modules has to lose to
        // the original tarball we downloaded — those bytes are byte-identical to
        // what the source registry serves, so their integrity hash still matches.
        items = [...deps, root];
      } else if (classified) {
        items = [{ ...classified, resolve: async () => tmpFile }];
        this.appendLog(jobId, `Detected a ${classified.type} artifact.`);
        this.patch(jobId, { name: `${classified.name}@${classified.version}` });
        if (classified.type === "maven") {
          const pom = await this.fetchMavenPom(jobId, input.sourceUrl, tmpDir, signal);
          if (pom) {
            // The pom states the groupId; the URL only implies it. Where the two
            // disagree the URL was read one segment too deep (an unrecognised
            // repository root), so the artifact's own target is rebuilt too —
            // both files have to land under the same group or neither resolves.
            const fixed = `${config.artifactory.mavenRepo}/${mavenLayoutPath(pom.coords, filename)}`;
            if (fixed !== classified.path) {
              this.appendLog(
                jobId,
                `The pom says ${pom.coords.groupId}:${pom.coords.artifactId} — ` +
                  `correcting the target to ${fixed}`
              );
              items[0] = { ...items[0], path: fixed, name: `${pom.coords.groupId}:${pom.coords.artifactId}` };
              this.patch(jobId, { name: `${pom.coords.groupId}:${pom.coords.artifactId}@${pom.coords.version}` });
            }
            items.push(pom.item);
          }
          if (input.includeDependencies) {
            // Root items last: uploadFiles dedupes by path keeping the *last*
            // entry, and a dependency the resolver also produced must lose to
            // the bytes we fetched from the source URL.
            items = [
              ...(await this.resolveToolDependencies(jobId, input.sourceUrl, classified, pom?.coords, tmpDir, signal)),
              ...items,
            ];
          }
        } else if (classified.type === "pypi" && input.includeDependencies) {
          items = [
            ...(await this.resolveToolDependencies(jobId, input.sourceUrl, classified, undefined, tmpDir, signal)),
            ...items,
          ];
        }
      } else {
        // A jar outside a repository layout — a release asset, a flat file
        // server — still carries its own coordinates. Without this it lands in
        // the default repo under its filename, which for a jar is the npm one.
        const coords = filename.toLowerCase().endsWith(".jar")
          ? await mavenCoordsFromJar(tmpFile)
          : null;
        if (coords && config.artifactory.mavenRepo) {
          items = [
            {
              path: `${config.artifactory.mavenRepo}/${mavenLayoutPath(coords, mavenFilename(coords, filename))}`,
              name: `${coords.groupId}:${coords.artifactId}`,
              version: coords.version,
              type: "maven",
              resolve: async () => tmpFile,
            },
          ];
          this.appendLog(jobId, `The jar says it is ${coords.groupId}:${coords.artifactId}:${coords.version}.`);
          this.patch(jobId, { name: `${coords.groupId}:${coords.artifactId}@${coords.version}` });
        } else {
          // ARTIFACTORY_REPO is the fallback repo and it is genuinely optional —
          // a deployment can set only the per-type ones. Uploading anyway built
          // the path `/<filename>` with no repo at all, which Artifactory
          // answers with a 404 reading "User authentication has failed due to
          // Repo key cannot be empty" — a message that sends the reader after a
          // token problem that does not exist.
          if (!config.artifactory.repo) {
            throw new Error(
              `${filename} matched no known package type, and ARTIFACTORY_REPO ` +
                `(the fallback repo for unrecognised files) is not set — nothing was uploaded.`
            );
          }
          items = [
            {
              path: `${config.artifactory.repo}/${filename}`,
              name: filename,
              version: "",
              type: "npm",
              resolve: async () => tmpFile,
            },
          ];
          this.appendLog(jobId, "Unrecognised artifact — uploading under its own filename.");
          this.patch(jobId, { name: filename });
        }
      }

      if (
        input.includeDependencies &&
        identity?.type !== "npm" &&
        classified?.type !== "maven" &&
        classified?.type !== "pypi"
      ) {
        this.dependencyFallback(
          jobId,
          "Only npm, Maven and PyPI artifacts have a resolvable dependency tree"
        );
      }

      // Same uploadFiles/finish path as a folder upload, so a URL copy fills in
      // `packages` and `progress` too — which is what makes the package table
      // (and its direct link) and the progress bar render for it at all.
      const results = await uploadFiles(
        items,
        (line) => this.appendLog(jobId, line),
        (done, total) => this.patch(jobId, { progress: { done, total } }),
        signal
      );

      this.finish(jobId, results);
    } catch (err) {
      if (this.aborted(jobId)) return;
      // userMessage, not err.message: Node's fetch throws a bare "fetch failed"
      // and the reason the user needs (ENOTFOUND, self-signed cert) is in .cause.
      const message = userMessage(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
      // appendLog already mirrored the message; this adds the stack and the
      // cause chain, which the user-facing job log deliberately does not carry.
      log.error("artifactory", `${jobId} failed`, err);
    } finally {
      await removeTmpDir(tmpDir, (line) => this.appendLog(jobId, line));
      this.controllers.delete(jobId);
      // Terminal by now on every path, and after the last appendLog above —
      // this is where the job and its log leave memory for the volume.
      await this.jobs.settle(jobId);
    }
  }

  /**
   * The `.pom` sibling of a URL-copied Maven artifact, as an upload item, or
   * `null`. A jar without its pom is unresolvable for anyone consuming the repo,
   * and the URL copy only ever fetches the one URL that was pasted.
   *
   * Missing is normal and quiet: a 404 (or any other failure) must not fail the
   * copy the user actually asked for.
   */
  private async fetchMavenPom(
    jobId: string,
    sourceUrl: string,
    tmpDir: string,
    signal: AbortSignal
  ): Promise<{ item: UploadItem; coords: MavenCoords } | null> {
    const pomUrl = mavenPomUrl(sourceUrl);
    if (!pomUrl) return null;
    if (!config.artifactory.mavenRepo) return null;

    try {
      const res = await fetch(pomUrl, { signal });
      if (!res.ok || !res.body) {
        this.appendLog(jobId, `No sibling pom (${res.status}) — copying the artifact alone.`);
        return null;
      }
      const filename = safeRelativePath(basename(new URL(pomUrl).pathname));
      const file = join(tmpDir, filename);
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(file),
        { signal }
      );

      // The pom's own coordinates decide where it goes: Artifactory answers a
      // pom deployed anywhere else with a 409, so a path guessed off the URL is
      // not good enough once the real answer is on disk.
      const coords = mavenCoordsFromPom(await readFile(file, "utf8"));
      if (!coords) {
        this.appendLog(jobId, `The sibling pom states no coordinates — copying the artifact alone.`);
        return null;
      }
      const path = `${config.artifactory.mavenRepo}/${mavenLayoutPath(coords, filename)}`;
      this.appendLog(jobId, `Also copying its pom: ${path}`);
      return {
        coords,
        item: {
          path,
          name: `${coords.groupId}:${coords.artifactId}`,
          version: coords.version,
          type: "maven",
          resolve: async () => file,
        },
      };
    } catch (err) {
      // A Stop is the caller's business; anything else is just "no pom".
      if (this.aborted(jobId)) throw err;
      this.appendLog(jobId, `Sibling pom not fetched (${userMessage(err)}) — copying the artifact alone.`);
      return null;
    }
  }

  /**
   * The Maven or PyPI dependency tree of a URL-copied artifact, as upload items,
   * or `[]`.
   *
   * Same contract as `resolveDependencies` below, and for the same reason:
   * everything that can go wrong here — the tool not being in this image, a
   * repository root that will not derive, a tree that will not resolve — is a
   * log line and a single-artifact copy, never a failed job. Only a Stop
   * propagates.
   *
   * The tools themselves do the copying: `dependency:copy-dependencies` and
   * `pip download` write directories in exactly the two layouts `classify`
   * already routes, so there is no dependency graph of our own to walk.
   */
  private async resolveToolDependencies(
    jobId: string,
    sourceUrl: string,
    classified: { type: string; name: string; version: string },
    coords: MavenCoords | undefined,
    tmpDir: string,
    signal: AbortSignal
  ): Promise<UploadItem[]> {
    try {
      let items: UploadItem[] | null;

      if (classified.type === "maven") {
        // copy-dependencies has nothing to resolve without the pom, and the
        // pom's own coordinates — not the URL's — are what it must be keyed on.
        if (!coords) {
          this.dependencyFallback(
            jobId,
            "No pom for this artifact, so its dependencies are unknown"
          );
          return [];
        }
        const filename = basename(new URL(sourceUrl).pathname);
        const repo = mavenRepoFromUrl(sourceUrl, coords, filename);
        if (!repo) {
          this.dependencyFallback(
            jobId,
            "The URL does not sit at the coordinates its pom declares, so no repository " +
              "root could be derived"
          );
          return [];
        }
        this.appendLog(jobId, `Source Maven repository: ${repo}`);
        items = await resolveMavenDependencies({
          coords,
          repo,
          token: sourceTokenFor(repo, config.artifactory.url, config.artifactory.token, ""),
          root: join(tmpDir, "mvn"),
          onLog: (line) => this.appendLog(jobId, line),
          signal,
        });
        if (items === null) {
          this.dependencyFallback(jobId, "maven is not installed in this image");
          return [];
        }
      } else {
        const index = pypiIndexFromUrl(sourceUrl);
        if (!index) {
          this.dependencyFallback(
            jobId,
            "No Python index could be derived from the URL (no /packages/ in its path)"
          );
          return [];
        }
        this.appendLog(jobId, `Source Python index: ${index}`);
        items = await resolvePypiDependencies({
          name: classified.name,
          version: classified.version,
          index,
          root: join(tmpDir, "pip"),
          onLog: (line) => this.appendLog(jobId, line),
          signal,
        });
        if (items === null) {
          this.dependencyFallback(jobId, "pip is not installed in this image");
          return [];
        }
      }

      if (items.length > MAX_DEPENDENCY_PACKAGES) {
        // Not a partial upload: a half-populated tree is a broken offline
        // install that gives no signal it is broken.
        this.dependencyFallback(
          jobId,
          `Dependency tree has ${items.length} file(s), over the ${MAX_DEPENDENCY_PACKAGES} cap`,
          "Use the folder upload tab for a tree this size."
        );
        return [];
      }

      this.appendLog(jobId, `Dependency tree: ${items.length} file(s).`);
      this.patch(jobId, {
        name: `${classified.name}@${classified.version} (+${items.length} deps)`,
      });
      return items;
    } catch (err) {
      // A cancel surfaces as an AbortError out of the spawn; swallowing it would
      // upload the artifact after the user had already pressed Stop.
      if (this.aborted(jobId) || signal.aborted) throw err;
      const message = userMessage(err);
      this.dependencyFallback(jobId, `Could not resolve dependencies (${message})`);
      log.warn("artifactory", `${jobId} dependency resolution failed`, { error: message });
      return [];
    }
  }

  /**
   * The npm dependency tree of a URL-copied artifact, as upload items, or `[]`.
   *
   * Never throws for a resolution problem. A URL copy that cannot resolve
   * dependencies still does the single-artifact copy it would have done with the
   * box unticked, and says in the log why it did not do more — the user asked to
   * copy a package, and half-answering that with a failed job helps nobody. The
   * one thing that does propagate is a Stop, which has to stay a Stop rather than
   * quietly falling through to an upload the user just cancelled.
   */
  private async resolveDependencies(
    jobId: string,
    sourceUrl: string,
    identity: { name: string; version: string },
    tmpDir: string,
    signal: AbortSignal
  ): Promise<UploadItem[]> {
    const registry = npmRegistryFromUrl(sourceUrl);
    if (!registry) {
      this.dependencyFallback(
        jobId,
        "No npm registry could be derived from the URL (no /-/ in its path)"
      );
      return [];
    }
    this.appendLog(jobId, `Source npm registry: ${registry}`);

    try {
      const packages = await resolveNpmDependencies({
        name: identity.name,
        version: identity.version,
        registry,
        token: sourceTokenFor(
          registry,
          config.artifactory.url,
          config.artifactory.token,
          config.artifactory.npmSourceToken
        ),
        root: join(tmpDir, "deps"),
        cacheDir: join(tmpDir, "npm-cache"),
        onLog: (line) => this.appendLog(jobId, line),
        signal,
      });

      if (packages.length > MAX_DEPENDENCY_PACKAGES) {
        // Not a partial upload: a half-populated tree is a broken offline install
        // that gives no signal it is broken.
        this.dependencyFallback(
          jobId,
          `Dependency tree has ${packages.length} package(s), over the ` +
            `${MAX_DEPENDENCY_PACKAGES} cap`,
          "Use the folder upload tab for a tree this size."
        );
        return [];
      }

      // The root is uploaded from the tarball we downloaded, not from its
      // repacked copy in node_modules — see the ordering note in runUrlCopy.
      const rootPath = targetPath(identity.name, identity.version);
      const items = npmUploadItems(packages, join(tmpDir, "stage")).filter(
        (item) => item.path !== rootPath
      );
      this.appendLog(jobId, `Dependency tree: ${items.length} package(s).`);
      this.patch(jobId, {
        name: `${identity.name}@${identity.version} (+${items.length} deps)`,
      });
      return items;
    } catch (err) {
      // A cancel surfaces as an AbortError out of the spawn; swallowing it would
      // upload the artifact after the user had already pressed Stop.
      if (this.aborted(jobId) || signal.aborted) throw err;
      const message = userMessage(err);
      this.dependencyFallback(jobId, `Could not resolve dependencies (${message})`);
      log.warn("artifactory", `${jobId} dependency resolution failed`, { error: message });
      return [];
    }
  }

  private async runFolderUpload(jobId: string, input: FolderUploadInput) {
    const signal = this.start(jobId);
    // the upload landed in a dir of its own, part by part; the job owns it now,
    // and drops it (archive included) in the `finally` below.
    const tmpDir = dirname(input.archivePath);
    try {
      this.patch(jobId, { status: "in-progress" });

      // One compressed blob + one native unzip beats tens of thousands of
      // uncompressed multipart parts and as many individual fs writes — this
      // is the whole reason a folder drop used to be ~100x slower than
      // dragging a hand-made zip of the same folder.
      const sourceDir = join(tmpDir, "source");
      this.appendLog(jobId, "Extracting uploaded archive ...");
      await mkdir(sourceDir, { recursive: true });
      try {
        await execFileAsync("unzip", ["-q", basename(input.archivePath), "-d", "source"], {
          cwd: tmpDir,
        });
      } catch (err) {
        // unzip exits 1 for "extracted, with warnings" (e.g. a Windows-built
        // zip warning about backslash separators) and only >= 2 for a real
        // failure — see RealWhiteningApi.submitUnpack for the same handling.
        const code = (err as { code?: number }).code;
        if (code !== 1) {
          throw new Error("Could not extract the uploaded folder archive");
        }
      }
      const relPaths = await listFilesRecursive(sourceDir);

      const log = (line: string) => this.appendLog(jobId, line);
      const packages = await discoverPackages(sourceDir, log);

      // A file inside a discovered npm package ships in that package's tarball —
      // a .jar under node_modules/foo/ is not a Maven dependency.
      const packageDirs = packages
        .map((p) => relative(sourceDir, p.dir).replace(/\\/g, "/"))
        .filter(Boolean);
      const loose = relPaths.filter(
        (p) => !packageDirs.some((d) => p === d || p.startsWith(`${d}/`))
      );

      // Every copy of a package covers its own files above; only one of them is
      // worth uploading.
      const unique = uniquePackages(packages, log);
      const items: UploadItem[] = npmUploadItems(unique, join(tmpDir, "stage"));

      // Everything below is classified by filename except Maven, which is
      // classified by where the file sits — so the folders above the tree have
      // to come off first.
      const mavenPrefix = await mavenTreePrefix(sourceDir, loose);
      if (mavenPrefix) {
        this.appendLog(jobId, `Maven repository root: ${mavenPrefix}/ — stripped from the target paths.`);
      }
      const target = (path: string) =>
        mavenPrefix && path.startsWith(`${mavenPrefix}/`) ? path.slice(mavenPrefix.length + 1) : path;

      let unrelated = 0;
      // Sniffing spawns a `tar` or an `unzip` per file, and on the two shapes
      // this form exists for — a flat folder of jars, a folder of loose
      // tarballs — that is *every* file. Sequentially, thousands of process
      // spawns were the job; the same pool the uploads use hides the latency.
      // Order inside `loose` carries no meaning: uploadFiles dedupes by target
      // path, and no two loose files share one.
      await pool(loose, SNIFF_CONCURRENCY, async (path) => {
        const found = classify(target(path), log);
        if (found) {
          // Already a finished artifact — nothing to pack, upload it as it is.
          items.push({ ...found, resolve: async () => join(sourceDir, path) });
          return;
        }
        // classify() deliberately leaves .tgz alone: the filename can't give the
        // scope (@babel/core ships as core-7.0.0.tgz) and can't tell an npm
        // package from a Helm chart, so the manifest inside decides. Without
        // this a folder of loose tarballs looks unrelated.
        const identity = path.toLowerCase().endsWith(".tgz")
          ? await readTarballIdentity(join(sourceDir, path))
          : null;
        if (identity) {
          const item = tarballUploadItem(identity, join(sourceDir, path), log);
          if (item) items.push(item);
          else unrelated++;
          return;
        }
        // Same idea one type over: a jar outside a repository layout carries its
        // own coordinates, which is the only thing that makes the flat folder
        // `mvn dependency:copy-dependencies` writes uploadable.
        const coords = path.toLowerCase().endsWith(".jar")
          ? await mavenCoordsFromJar(join(sourceDir, path))
          : null;
        if (coords) {
          if (!config.artifactory.mavenRepo) {
            log(`ARTIFACTORY_MAVEN_REPO not set — skipping ${basename(path)}`);
            unrelated++;
            return;
          }
          items.push({
            path: `${config.artifactory.mavenRepo}/${mavenLayoutPath(coords, mavenFilename(coords, path))}`,
            name: `${coords.groupId}:${coords.artifactId}`,
            version: coords.version,
            type: "maven",
            resolve: async () => join(sourceDir, path),
          });
          return;
        }
        unrelated++;
      });

      if (items.length === 0) {
        // Uploading the tree verbatim used to be the fallback here, which
        // quietly published a junk folder into the npm repo under its own name.
        // Failing is the honest answer: nothing in the drop was a package.
        throw new Error(
          `No recognised packages in ${input.folderName} — ` +
            `${loose.length} file(s) matched no known package type. Nothing was uploaded.`
        );
      }

      this.patch(jobId, { name: jobName(unique, input.folderName) });
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
      this.appendLog(
        jobId,
        `Found ${[...counts].map(([type, n]) => `${n} ${type}`).join(", ")} package(s).`
      );
      if (unrelated > 0) {
        this.appendLog(jobId, `${unrelated} unrelated file(s) skipped.`);
      }

      const results = await uploadFiles(
        items,
        log,
        (done, total) => this.patch(jobId, { progress: { done, total } }),
        signal
      );

      this.finish(jobId, results);
    } catch (err) {
      if (this.aborted(jobId)) return;
      // userMessage, not err.message: Node's fetch throws a bare "fetch failed"
      // and the reason the user needs (ENOTFOUND, self-signed cert) is in .cause.
      const message = userMessage(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
      // appendLog already mirrored the message; this adds the stack and the
      // cause chain, which the user-facing job log deliberately does not carry.
      log.error("artifactory", `${jobId} failed`, err);
    } finally {
      await removeTmpDir(tmpDir, (line) => this.appendLog(jobId, line));
      this.controllers.delete(jobId);
      // Terminal by now on every path, and after the last appendLog above —
      // this is where the job and its log leave memory for the volume.
      await this.jobs.settle(jobId);
    }
  }

}

/**
 * What to call a jar whose coordinates were sniffed out of it. Its own name is
 * kept when it already starts with `<artifactId>-<version>`, so a classifier
 * (`-sources`, `-javadoc`) survives; anything else is renamed to the canonical
 * form, since a renamed jar at a layout path resolves for nobody.
 */
function mavenFilename(coords: MavenCoords, path: string): string {
  const name = basename(path);
  return name.startsWith(`${coords.artifactId}-${coords.version}`)
    ? name
    : `${coords.artifactId}-${coords.version}.jar`;
}

/**
 * Maven coordinates out of a jar's own `META-INF/maven/<g>/<a>/pom.properties`,
 * which every jar Maven builds carries. This is what makes a *flat* folder of
 * jars uploadable at all — `mvn dependency:copy-dependencies` writes exactly
 * that, and a filename alone cannot give the groupId.
 *
 * `null` for a jar without one (hand-built, shaded, or repackaged), which then
 * falls through to the same "unrelated file" path as before.
 *
 * The embedded `pom.xml` beside it is deliberately *not* uploaded with the jar:
 * a pom whose `<parent>` is not in the repo fails resolution outright, which is
 * worse than the "Missing POM" warning a jar on its own produces.
 */
async function mavenCoordsFromJar(file: string): Promise<MavenCoords | null> {
  try {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-p", basename(file), "META-INF/maven/*/*/pom.properties"],
      { cwd: dirname(file), maxBuffer: 1024 * 1024 }
    );
    // A shaded jar carries one block per bundled artifact; the first is the jar
    // itself, the rest are what it swallowed.
    const read = (key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(stdout)?.[1].trim() ?? "";
    const groupId = read("groupId");
    const artifactId = read("artifactId");
    const version = read("version");
    if (!groupId || !artifactId || !version) return null;
    return { groupId, artifactId, version };
  } catch {
    // Not a zip, no such entry, or no unzip on PATH.
    return null;
  }
}

/** What a `.tgz` turned out to be. npm and Helm both use the extension. */
type TarballIdentity = { type: "npm" | "helm"; name: string; version: string };

/**
 * Read a tarball's identity out of the manifest inside it — the filename alone
 * cannot tell you the scope (`@babel/core` ships as `core-7.0.0.tgz`) and
 * cannot tell an npm package from a Helm chart at all, since both are gzipped
 * tars named `<something>-<version>.tgz`.
 *
 * npm is tried first because its manifest is at an exact path; Helm's needs a
 * wildcard, since the directory is the chart's own name. Returns null for
 * anything that is neither.
 */
async function readTarballIdentity(file: string): Promise<TarballIdentity | null> {
  const read = async (args: string[]) => {
    // Relative to cwd — GNU tar treats a `C:` prefix as a remote host spec.
    const { stdout } = await execFileAsync("tar", ["-xzOf", basename(file), ...args], {
      cwd: dirname(file),
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };

  try {
    const manifest = JSON.parse(await read(["package/package.json"]));
    if (typeof manifest.name === "string" && typeof manifest.version === "string") {
      return { type: "npm", name: manifest.name, version: manifest.version };
    }
  } catch {
    // Not an npm tarball. Fall through to the Helm check.
  }

  try {
    // --no-wildcards-match-slash keeps `*` inside one segment: without it the
    // pattern also matches `<chart>/charts/<subchart>/Chart.yaml`, and `-O`
    // would concatenate a subchart's manifest onto the parent's.
    const chart = await read(["--wildcards", "--no-wildcards-match-slash", "*/Chart.yaml"]);
    // A scan, not a YAML parser: these two keys are plain scalars at column 0
    // in every chart, and `appVersion` cannot match `^version`.
    const pick = (key: string) =>
      new RegExp(`^${key}:\\s*['"]?([^'"\\s#]+)`, "m").exec(chart)?.[1] ?? "";
    const name = pick("name");
    const version = pick("version");
    if (name && version) return { type: "helm", name, version };
  } catch {
    // Not a tarball, no manifest inside it, or no tar on PATH — the caller falls
    // back to the flat upload path rather than failing the whole job.
  }
  return null;
}

/**
 * The upload item for a sniffed `.tgz`. `null` when the repo for its type is
 * unset, which is reported the same way `classify` reports a missing type repo.
 */
function tarballUploadItem(
  identity: TarballIdentity,
  file: string,
  onSkip: (message: string) => void
): UploadItem | null {
  const path =
    identity.type === "helm"
      ? helmTargetPath(identity.name, identity.version, onSkip)
      : targetPath(identity.name, identity.version);
  if (!path) return null;
  return {
    path,
    name: identity.name,
    version: identity.version,
    type: identity.type,
    resolve: async () => file,
  };
}
