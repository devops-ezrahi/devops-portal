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
export const IMPORTER_DIR = "gitops-factory";

/**
 * `namespace_importer.py`'s full-namespace pull, run over pasted YAML instead
 * of a cluster. Every read it makes goes through `run_oc`, so answering that
 * from the paste is the whole adapter: the grouping into microservices,
 * `shared.yaml`, the ExternalSecret store placement and the metadata cleaning
 * are the importer's own, not a second copy of them. A reference the paste does
 * not hold becomes the importer's own fetch failure, reported as a warning.
 */
const SPLIT_DUMP = `
import json, subprocess, sys, types, yaml
sys.path.insert(0, sys.argv[1])
import namespace_importer as ni
dump, ns, out, failures = sys.argv[2:6]
docs = ni.parse_yaml_stream(open(dump, encoding="utf-8").read())
def run_oc(args):
    kind = ni.RESOURCE_PLURAL_TO_KIND.get(args[1].split(".")[0])
    name = args[2] if len(args) > 2 and not args[2].startswith("-") else None
    hits = [d for d in docs if d.get("kind") == kind and (name is None or (d.get("metadata") or {}).get("name") == name)]
    if name is None:
        return types.SimpleNamespace(stdout=yaml.safe_dump({"kind": "List", "items": hits}))
    if not hits:
        raise subprocess.CalledProcessError(1, args, stderr="referenced, but not in the pasted YAML")
    return types.SimpleNamespace(stdout=yaml.safe_dump(hits[0]))
ni.run_oc = run_oc
ni.handle_full_namespace(ns, types.SimpleNamespace(output=out))
open(failures, "w", encoding="utf-8").write(json.dumps(ni.FETCH_FAILURES))
`;

export type ConvertInput = {
  chartRepoUrl: string;
  chartRevision: string;
  namespace: string;
  /**
   * Any Kubernetes YAML — `kubectl get -o yaml` output, a `List`, several files
   * joined — split into microservices by the importer before converting.
   */
  yaml?: string;
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
    const warnings: string[] = [];
    if (input.yaml) {
      const importer = join(dir, "chart", IMPORTER_DIR);
      if (!(await access(join(importer, "namespace_importer.py")).then(() => true, () => false)))
        throw new Error(`${input.chartRepoUrl}@${input.chartRevision} has no ${IMPORTER_DIR}/namespace_importer.py to split the YAML with`);
      await writeFile(join(dir, "dump.yaml"), input.yaml, "utf8");
      const failures = join(dir, "failures.json");
      await run(python, ["-c", SPLIT_DUMP, importer, join(dir, "dump.yaml"), input.namespace, join(dir, "in"), failures], dir, "Splitting the YAML");
      warnings.push(...(JSON.parse(await readFile(failures, "utf8")) as string[]));
    }

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
    for (const l of report.split("\n").map((l) => l.trim())) if (l && !/^[=#-]+$/.test(l)) warnings.push(l);
    log.info("argocd", "converted", {
      namespace: input.namespace,
      microservices: files.filter((f) => f.path.startsWith("base/")).length,
      files: files.length,
      warnings: warnings.length,
    });
    return { files, warnings };
  } finally {
    await removeTmpDir(dir);
  }
}
