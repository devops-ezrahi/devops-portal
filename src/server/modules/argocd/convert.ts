import { execFile } from "child_process";
import { access, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { cloneAt, withCredentials } from "../../git";
import { log } from "../../log";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import type { RepoFile } from "./valuesGit";
import { valuesTokenFor } from "./valuesRepo";

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
 *
 * A namespace is a folder, exactly as it is to the converter (`<input>/<ns>/`):
 * each document goes to its own `metadata.namespace`, and one that names none —
 * which is all of `helm template`'s output — to the default the request names.
 * Each namespace is pulled on its own, so its microservices only see its docs.
 */
const SPLIT_DUMP = `
import json, os, re, subprocess, sys, types, yaml
sys.path.insert(0, sys.argv[1])
import namespace_importer as ni
dump, default_ns, out, failures = sys.argv[2:6]
by_ns = {}
for d in ni.parse_yaml_stream(open(dump, encoding="utf-8").read()):
    by_ns.setdefault((d.get("metadata") or {}).get("namespace") or default_ns, []).append(d)
for ns in by_ns:
    if not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", ns):
        sys.exit(f"metadata.namespace '{ns}' is not a Kubernetes namespace name")
docs = []
notes = []
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
def written(ns):
    seen = set()
    for root, _, names in os.walk(os.path.join(out, ns)):
        for n in names:
            if n.endswith((".yaml", ".yml")):
                try:
                    for d in yaml.safe_load_all(open(os.path.join(root, n), encoding="utf-8")):
                        if isinstance(d, dict):
                            seen.add((d.get("kind"), (d.get("metadata") or {}).get("name")))
                except yaml.YAMLError:
                    pass
    return seen
for ns, ns_docs in by_ns.items():
    docs[:] = ns_docs
    # One namespace the importer cannot use (a stray ConfigMap whose
    # metadata.namespace names another one: "No workloads found") used to end
    # the whole run, and the paste's every other namespace with it.
    stopped = None
    try:
        ni.handle_full_namespace(ns, types.SimpleNamespace(output=out))
    except SystemExit as e:
        stopped = e.code if isinstance(e.code, str) else "the importer stopped"
    # A paste is all app: what the selective pull skipped (config no pod
    # mounts, Roles, cluster-scoped kinds, a workload no app label found) is
    # filed into the converter's input rather than reported lost. Older chart
    # revisions have no file_unclaimed, and keep the report below.
    if hasattr(ni, "file_unclaimed"):
        notes.extend(f"{n} (namespace {ns})" for n in ni.file_unclaimed(os.path.join(out, ns), ns_docs))
    elif stopped:
        ni.FETCH_FAILURES.append(f"Namespace '{ns}': not converted — {stopped}")
        continue
    # What the paste held that never reached the converter's input — a
    # DeploymentConfig, an ImageStream, hand-made Endpoints — is named, not lost.
    kept = written(ns)
    for d in ns_docs:
        key = (d.get("kind"), (d.get("metadata") or {}).get("name"))
        if key[0] and key not in kept and key[0] not in getattr(ni, "UNCLAIMED_SKIP_KINDS", ()) \
                and not any(n.startswith(f"{key[0]}/{key[1]}:") for n in notes):
            ni.FETCH_FAILURES.append(f"{key[0]}/{key[1]} (namespace {ns}): in the pasted YAML, but not carried into the conversion")
open(failures, "w", encoding="utf-8").write(json.dumps(ni.FETCH_FAILURES + notes))
`;

export type ConvertInput = {
  chartRepoUrl: string;
  chartRevision: string;
  /** Where a document naming no `metadata.namespace` goes — every document a Helm chart renders. */
  namespace: string;
  /** `--env-group` specs, `color=black,yellow`: a token in a release name makes a variant folder. */
  envGroups?: string[];
  /**
   * Any Kubernetes YAML — `kubectl get -o yaml` output, a `List`, several files
   * joined — split into microservices by the importer before converting.
   */
  yaml?: string;
  /**
   * A packaged chart (`helm package` output), base64. Rendered under its own
   * `Chart.yaml` name, then split exactly like pasted YAML — a chart that
   * renders several workloads is several microservices.
   */
  helm?: { archive: string; values?: string };
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

/**
 * `run`, but a non-zero exit is a result rather than an error — the converter
 * exits 1 when its verification finds a problem, after writing the tree.
 */
async function runChecked(
  cmd: string,
  args: string[],
  cwd: string,
  what: string
): Promise<{ failed: boolean; output: string; tail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
    return { failed: false, output: `${stdout}\n${stderr}`, tail: "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed in this image, so ${what} cannot run`);
    if (e.killed) throw new Error(`${what} timed out`);
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    return { failed: true, output, tail: output.trim().split("\n").slice(-6).join("\n") || e.message };
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

/** A chart's own `name:` as a release name — `helm template` wants a DNS label. */
async function chartName(dir: string): Promise<string> {
  const text = await readFile(join(dir, "Chart.yaml"), "utf8");
  const name = /^name:\s*["']?([^"'\s#]+)/m.exec(text)?.[1] ?? "";
  const release = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 53);
  if (!release) throw new Error("The chart's Chart.yaml has no name");
  return release;
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
    // The chart repo is usually private on the values repo's own host, so the
    // values token applies — `valuesTokenFor` only hands it to that host.
    const { token, username } = valuesTokenFor(input.chartRepoUrl);
    await cloneAt(withCredentials(input.chartRepoUrl, token, username), input.chartRevision, join(dir, "chart"), 120_000);
    const converter = join(dir, "chart", CONVERTER_PATH);
    if (!(await access(converter).then(() => true, () => false)))
      throw new Error(`${input.chartRepoUrl}@${input.chartRevision} has no ${CONVERTER_PATH} to convert with`);

    // A chart is rendered first; what comes out is the same plain YAML a paste is.
    let manifests = input.yaml ?? "";
    if (input.helm) {
      const helmDir = join(dir, "helm");
      await mkdir(join(helmDir, "src"), { recursive: true });
      await writeFile(join(helmDir, "chart.tgz"), Buffer.from(input.helm.archive, "base64"));
      // Relative, from the destination: GNU tar reads a leading `C:` as a host.
      await run("tar", ["-xf", "../chart.tgz"], join(helmDir, "src"), "Unpacking the chart");
      const src = await chartDir(join(helmDir, "src"));
      const args = ["template", await chartName(src), src, "--namespace", input.namespace];
      if (input.helm.values?.trim()) {
        await writeFile(join(helmDir, "values.yaml"), input.helm.values, "utf8");
        args.push("-f", join(helmDir, "values.yaml"));
      }
      manifests = await run("helm", args, helmDir, "helm template");
    }

    const importer = join(dir, "chart", IMPORTER_DIR);
    if (!(await access(join(importer, "namespace_importer.py")).then(() => true, () => false)))
      throw new Error(`${input.chartRepoUrl}@${input.chartRevision} has no ${IMPORTER_DIR}/namespace_importer.py to split the YAML with`);
    await mkdir(join(dir, "in"), { recursive: true });
    await writeFile(join(dir, "dump.yaml"), manifests, "utf8");
    const failures = join(dir, "failures.json");
    await run(python, ["-c", SPLIT_DUMP, importer, join(dir, "dump.yaml"), input.namespace, join(dir, "in"), failures], dir, "Splitting the YAML");
    const warnings = JSON.parse(await readFile(failures, "utf8")) as string[];

    // Verified, not --skip-verify: the converter renders every release with
    // helm and checks no two claim one object. Skipping it turned a tree that
    // cannot render (Harbor's shared Ingress) or that two releases fight over
    // (Kafka's ServiceAccount) into a quiet success that failed in Argo CD.
    // A failed check still returns the tree — it is what the user edits to fix
    // it — with the failure leading the warnings.
    const groups = (input.envGroups ?? []).flatMap((g) => ["--env-group", g]);
    const verify = await runChecked(
      python,
      [converter, "--input", join(dir, "in"), "--output", join(dir, "out"), "--chart", join(dir, "chart"), ...groups],
      dir,
      "The converter"
    );
    if (verify.failed && !(await access(join(dir, "out", "base")).then(() => true, () => false)))
      throw new Error(`The converter failed: ${redactSecrets(verify.tail)}`);

    const files = await readTree(join(dir, "out"));
    const conflicts = await readFile(join(dir, "out", "report", "render_conflicts.txt"), "utf8").catch(() => "");
    const problems = [
      ...conflicts.split("\n").map((l) => l.trim()).filter((l) => /CONFLICT/.test(l)),
      ...verify.output.split("\n").map((l) => l.trim()).filter((l) => /^helm template failed|^RENDER FAILURE/.test(l)),
    ];
    if (verify.failed)
      warnings.unshift(
        ...(problems.length ? problems : [verify.tail]).map((l) => `Does not render cleanly — Argo CD would fail to sync this: ${redactSecrets(l)}`)
      );
    const report = await readFile(join(dir, "out", "report", "conflicts_and_warnings.txt"), "utf8").catch(() => "");
    for (const l of report.split("\n").map((l) => l.trim())) if (l && !/^[=#-]+$/.test(l)) warnings.push(l);
    log.info("argocd", "converted", {
      defaultNamespace: input.namespace,
      microservices: files.filter((f) => f.path.startsWith("base/")).length,
      files: files.length,
      warnings: warnings.length,
    });
    return { files, warnings };
  } finally {
    await removeTmpDir(dir);
  }
}
