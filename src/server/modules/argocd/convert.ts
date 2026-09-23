import { execFile } from "child_process";
import { access, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { git, withCredentials } from "../../git";
import { log } from "../../log";
import { redactSecrets } from "../../redact";
import { tokenFor } from "../../repoGuards";
import { createTmpDir, removeTmpDir } from "../../tmp";
import type { RepoFile } from "./valuesGit";

const execFileAsync = promisify(execFile);

/**
 * Plain Kubernetes YAML, or a Helm chart, turned into a universal-chart values
 * tree — by `convert_to_universal_chart.py` itself, not by a port of it.
 *
 * The converter is 5 000 lines of Python whose output layout this module
 * already reads (`importTree`), and a TypeScript copy would drift from it the
 * way CLAUDE.md warns `values.ts` must not. So it is run, from the tree's own
 * chart repo at the tree's own revision: the converter that ships beside a
 * chart version is the one that writes values for it, and the chart repo is
 * already mirrored wherever ArgoCD can render from it. Nothing to vendor, no
 * second copy to keep in step.
 *
 * A Helm chart is rendered with `helm template` first; what comes out is the
 * same plain YAML the other path takes.
 */

export const CONVERTER_PATH = "gitops-factory/convert_to_universal_chart.py";

export type ConvertInput = {
  chartRepoUrl: string;
  chartRevision: string;
  namespace: string;
  /** One microservice per entry — the converter reads one file per microservice. */
  manifests?: { name: string; text: string }[];
  /** A packaged chart (`helm package` output), base64. */
  helm?: { name: string; archive: string; values?: string };
};

export type ConvertResult = { files: RepoFile[]; warnings: string[] };

const python = process.platform === "win32" ? "python" : "python3";

async function run(cmd: string, args: string[], cwd: string, what: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed in this image, so ${what} cannot run`);
    // The last lines are where Python and helm say what went wrong.
    const detail = String(e.stderr || e.message).trim().split("\n").slice(-6).join("\n");
    throw new Error(`${what} failed: ${redactSecrets(detail)}`);
  }
}

/** Every `.yaml` under `dir` except the converter's own report. */
async function readTree(dir: string, prefix = ""): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel !== "report") out.push(...(await readTree(join(dir, entry.name), rel)));
    } else if (/\.ya?ml$/.test(entry.name)) {
      out.push({ path: rel, text: await readFile(join(dir, entry.name), "utf8") });
    }
  }
  return out;
}

/** The directory holding `Chart.yaml` at the top of an unpacked chart. */
async function chartDir(root: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (await access(join(candidate, "Chart.yaml")).then(() => true, () => false)) return candidate;
  }
  throw new Error("That archive holds no Chart.yaml — expected the .tgz `helm package` writes");
}

export async function convertToUniversal(input: ConvertInput): Promise<ConvertResult> {
  const dir = await createTmpDir("ag-convert-");
  try {
    const { token, username } = tokenFor(input.chartRepoUrl);
    await git(
      ["clone", "--depth", "1", "--branch", input.chartRevision, "--", withCredentials(input.chartRepoUrl, token, username), join(dir, "chart")],
      undefined,
      120_000
    );
    const converter = join(dir, "chart", CONVERTER_PATH);
    if (!(await access(converter).then(() => true, () => false)))
      throw new Error(`${input.chartRepoUrl}@${input.chartRevision} has no ${CONVERTER_PATH} to convert with`);

    const inDir = join(dir, "in", input.namespace);
    await mkdir(inDir, { recursive: true });
    for (const m of input.manifests ?? []) await writeFile(join(inDir, `${m.name}.yaml`), m.text, "utf8");

    if (input.helm) {
      const helmDir = join(dir, "helm");
      await mkdir(join(helmDir, "src"), { recursive: true });
      await writeFile(join(helmDir, "chart.tgz"), Buffer.from(input.helm.archive, "base64"));
      // Relative, from the destination: GNU tar reads a leading `C:` as a host.
      await run("tar", ["-xf", "../chart.tgz"], join(helmDir, "src"), "Unpacking the chart");
      const args = ["template", input.helm.name, await chartDir(join(helmDir, "src")), "--namespace", input.namespace];
      if (input.helm.values?.trim()) {
        await writeFile(join(helmDir, "values.yaml"), input.helm.values, "utf8");
        args.push("-f", join(helmDir, "values.yaml"));
      }
      const rendered = await run("helm", args, helmDir, "helm template");
      await writeFile(join(inDir, `${input.helm.name}.yaml`), rendered, "utf8");
    }

    // --skip-verify: verification renders every release through the chart with
    // helm, which is a check for the converter's own CI, not for this request.
    await run(python, [converter, "--input", join(dir, "in"), "--output", join(dir, "out"), "--skip-verify"], dir, "The converter");

    const files = await readTree(join(dir, "out"));
    const report = await readFile(join(dir, "out", "report", "conflicts_and_warnings.txt"), "utf8").catch(() => "");
    const warnings = report
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^[=#-]+$/.test(l));
    log.info("argocd", "converted", {
      namespace: input.namespace,
      microservices: (input.manifests?.length ?? 0) + (input.helm ? 1 : 0),
      files: files.length,
      warnings: warnings.length,
    });
    return { files, warnings };
  } finally {
    await removeTmpDir(dir);
  }
}
