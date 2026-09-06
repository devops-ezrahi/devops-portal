import { clean, flow, raw } from "./yaml";
import type { Values } from "./values";

/**
 * The chart's surface, transcribed by hand from `universal-chart`'s
 * `values.yaml` and its own `ui/studio.html` catalog — one `FeatureSpec` per
 * section, in the order the generated file lists them.
 *
 * Same deal as `jenkinsfile/catalog.ts`: **when the chart gains or renames a
 * value, update this file** — nothing reads the chart repo at runtime. That is
 * deliberate. No clone step, no YAML fetch, and no way for a network failure to
 * leave the builder empty.
 */

export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "text" // one list entry per line
  | "yaml" // a block written through verbatim
  | "kv" // key/value rows
  | "rows"; // repeated groups of fixed columns

export type RowCol = { key: string; label: string; kind?: "string" | "number" | "boolean" | "select"; options?: string[]; placeholder?: string };

export type FieldSpec = {
  key: string;
  kind: FieldKind;
  label: string;
  /**
   * Where this field lands in `values.yaml`. Present on every field whose emit
   * is a straight scalar assignment, which is what lets the importer invert it
   * without a hand-written reader per feature.
   */
  path?: string;
  placeholder?: string;
  hint?: string;
  options?: string[];
  cols?: RowCol[];
  def?: unknown;
};

export type FeatureSpec = {
  id: string;
  cat: string;
  name: string;
  /** The top-level `values.yaml` keys this feature owns — drives key order and import routing. */
  keys: string[];
  blurb: string;
  fields: FieldSpec[];
  notes?: string[];
  /** Feature state -> a values fragment. Pure; `null` means "contributes nothing". */
  emit: (v: FieldValues) => Values | null;
  /** Values fragment -> feature state. Only needed where `path` cannot say it (rows, kv, lists). */
  load?: (doc: Values) => FieldValues | null;
};

export type FieldValues = Record<string, unknown>;
export type FeatureState = { on: boolean; v: FieldValues };

export const CATEGORIES = [
  { id: "core", name: "Core" },
  { id: "container", name: "Container" },
  { id: "storage", name: "Storage" },
  { id: "network", name: "Networking" },
  { id: "config", name: "Config & Secrets" },
  { id: "batch", name: "Jobs" },
  { id: "scale", name: "Scaling & Availability" },
  { id: "sched", name: "Scheduling & Security" },
  { id: "ops", name: "Identity & Observability" },
  { id: "escape", name: "Escape Hatches" },
] as const;

/* ---------- emit helpers (ported from studio.html) ---------- */

export const nz = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
export const put = (o: Values, k: string, v: unknown): Values => {
  if (nz(v)) o[k] = v;
  return o;
};
export const putn = (o: Values, k: string, v: unknown): Values => {
  if (nz(v) && Number.isFinite(Number(v))) o[k] = Number(v);
  return o;
};
export const some = (o: Values): Values | null => (Object.keys(clean(o)).length ? clean(o) : null);
export const listOf = (t: unknown): string[] =>
  String(t ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
export type KvPair = { k: string; v: string };
export const kvOf = (rows: unknown): Values | null => {
  const m: Values = {};
  (rows as KvPair[] | undefined)?.forEach((r) => {
    if (nz(r?.k)) m[r.k] = r.v ?? "";
  });
  return Object.keys(m).length ? m : null;
};
/** The inverse of `kvOf`, for import: a values map back into editable rows. */
export const pairsOf = (map: unknown): KvPair[] =>
  isRecord(map) ? Object.entries(map).map(([k, v]) => ({ k, v: String(v ?? "") })) : [];
export const rowsOf = (v: unknown): Values[] => (Array.isArray(v) ? (v as Values[]) : []);
export const isRecord = (v: unknown): v is Values => !!v && typeof v === "object" && !Array.isArray(v);
/** `name`-keyed map built from rows — the shape most of the chart's lists take. */
export const mapOf = (rows: unknown, fn: (r: Values) => Values | null, key = "name"): Values | null => {
  const m: Values = {};
  rowsOf(rows).forEach((r) => {
    const n = r[key];
    if (!nz(n)) return;
    const body = fn(r);
    if (body) m[String(n)] = body;
  });
  return Object.keys(m).length ? m : null;
};

/* ---------- field shorthands ---------- */
type Extra = Partial<Omit<FieldSpec, "key" | "kind" | "label">>;
const S = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "string", label, ...o });
const N = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "number", label, ...o });
const B = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "boolean", label, ...o });
const SE = (key: string, label: string, options: string[], o: Extra = {}): FieldSpec => ({ key, kind: "select", label, options, ...o });
const KV = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "kv", label, ...o });
const TX = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "text", label, ...o });
const YA = (key: string, label: string, o: Extra = {}): FieldSpec => ({ key, kind: "yaml", label, ...o });
const RW = (key: string, label: string, cols: RowCol[], o: Extra = {}): FieldSpec => ({ key, kind: "rows", label, cols, ...o });

export const FEATURES: FeatureSpec[] = [];
const F = (spec: FeatureSpec): FeatureSpec => {
  FEATURES.push(spec);
  return spec;
};

/* ---------- core ---------- */

F({
  id: "identity",
  cat: "core",
  name: "Release identity",
  keys: ["nameOverride", "fullnameOverride", "commonLabels", "commonAnnotations"],
  blurb: "The name every object in the release is built from, plus labels and annotations stamped onto all of them.",
  fields: [
    S("nameOverride", "nameOverride", { path: "nameOverride", placeholder: "checkout-api", hint: "Resource names become exactly this, not <release>-<chart>. A GitOps tree should always set it." }),
    S("fullnameOverride", "fullnameOverride", { path: "fullnameOverride", hint: "Wins over nameOverride. Rarely needed." }),
    KV("commonLabels", "commonLabels"),
    KV("commonAnnotations", "commonAnnotations"),
  ],
  emit: (v) =>
    some({
      nameOverride: v.nameOverride,
      fullnameOverride: v.fullnameOverride,
      commonLabels: kvOf(v.commonLabels),
      commonAnnotations: kvOf(v.commonAnnotations),
    }),
  load: (doc) => ({
    nameOverride: doc.nameOverride ?? "",
    fullnameOverride: doc.fullnameOverride ?? "",
    commonLabels: pairsOf(doc.commonLabels),
    commonAnnotations: pairsOf(doc.commonAnnotations),
  }),
  notes: [
    "nameOverride is the one to set. Without it the chart builds names as <release>-<chart>, which is almost never what a converted manifest wants.",
  ],
});

F({
  id: "workload",
  cat: "core",
  name: "Workload type",
  keys: ["workload"],
  blurb: "Pick one. This decides which object carries your pods — or that the release owns no pods at all.",
  fields: [SE("type", "workload.type", ["deployment", "statefulset", "daemonset", "none"], { def: "deployment", path: "workload.type" })],
  emit: (v) => ({ workload: { type: v.type || "deployment" } }),
  notes: [
    "statefulset when pods need stable hostnames or per-pod storage, daemonset for node-level agents, none for a config/RBAC-only release.",
    "workload.type: none fails the chart's validation if hpa, vpa or pdb are enabled — there are no pods to scale, resize or protect.",
  ],
});

F({
  id: "image",
  cat: "core",
  name: "Image & pull secrets",
  keys: ["image", "imagePullSecrets"],
  blurb: "Where the container comes from. A digest pins harder than a tag and wins over it when both are set.",
  fields: [
    S("repository", "image.repository", { path: "image.repository", placeholder: "registry.example.com/team/backend" }),
    S("tag", "image.tag", { path: "image.tag", placeholder: "2.3.1", hint: "Leave empty to fall back to Chart.appVersion." }),
    S("digest", "image.digest", { path: "image.digest", placeholder: "sha256:abc123…", hint: "Wins over tag." }),
    SE("pullPolicy", "image.pullPolicy", ["", "Always", "IfNotPresent", "Never"], { path: "image.pullPolicy" }),
    TX("pullSecrets", "imagePullSecrets", { placeholder: "my-registry-pull-secret", hint: "One secret name per line." }),
  ],
  emit: (v) =>
    some({
      image: some({ repository: v.repository, tag: v.tag, digest: v.digest, pullPolicy: v.pullPolicy }),
      imagePullSecrets: listOf(v.pullSecrets).map((name) => ({ name })),
    }),
  load: (doc) => {
    const image = isRecord(doc.image) ? doc.image : {};
    return {
      repository: image.repository ?? "",
      tag: image.tag ?? "",
      digest: image.digest ?? "",
      pullPolicy: image.pullPolicy ?? "",
      pullSecrets: rowsOf(doc.imagePullSecrets)
        .map((r) => String(r.name ?? ""))
        .join("\n"),
    };
  },
  notes: [
    "A private registry needs the pull secret on the pod or on the ServiceAccount — repo access alone does not imply registry access.",
  ],
});

F({
  id: "replicas",
  cat: "core",
  name: "Replicas & rollout",
  keys: [
    "replicaCount",
    "revisionHistoryLimit",
    "progressDeadlineSeconds",
    "minReadySeconds",
    "podManagementPolicy",
    "serviceName",
    "strategy",
  ],
  blurb: "How many pods, and how a new version replaces the old ones.",
  fields: [
    N("replicaCount", "replicaCount", { path: "replicaCount", placeholder: "3" }),
    N("revisionHistoryLimit", "revisionHistoryLimit", { path: "revisionHistoryLimit", placeholder: "3" }),
    N("progressDeadlineSeconds", "progressDeadlineSeconds", { path: "progressDeadlineSeconds", placeholder: "600", hint: "Deployment only. Empty omits the field." }),
    N("minReadySeconds", "minReadySeconds", { path: "minReadySeconds", placeholder: "0" }),
    SE("podManagementPolicy", "podManagementPolicy", ["", "OrderedReady", "Parallel"], { path: "podManagementPolicy", hint: "StatefulSet only." }),
    S("serviceName", "serviceName", { path: "serviceName", placeholder: "redis-cache-headless", hint: "StatefulSet governing Service. Only a headless Service publishes per-pod DNS." }),
    YA("strategy", "strategy", { placeholder: "type: RollingUpdate\nrollingUpdate:\n  maxSurge: 1\n  maxUnavailable: 0" }),
  ],
  emit: (v) => {
    const o: Values = {};
    putn(o, "replicaCount", v.replicaCount);
    putn(o, "revisionHistoryLimit", v.revisionHistoryLimit);
    putn(o, "progressDeadlineSeconds", v.progressDeadlineSeconds);
    putn(o, "minReadySeconds", v.minReadySeconds);
    put(o, "podManagementPolicy", v.podManagementPolicy);
    put(o, "serviceName", v.serviceName);
    if (nz(v.strategy)) o.strategy = raw(v.strategy);
    return some(o);
  },
  notes: [
    "StatefulSet canary: rollingUpdate.partition: 2 updates only pods with ordinal >= 2. Set it back to 0 to finish the rollout.",
    "DaemonSet takes maxUnavailable (one node at a time) or OnDelete.",
  ],
});

F({
  id: "container",
  cat: "core",
  name: "Container basics",
  keys: ["containerName", "command", "args", "workingDir", "restartPolicy", "terminationGracePeriodSeconds", "containerRestartPolicy"],
  blurb: "The one container this chart manages: its name, its entrypoint and how long it gets to shut down.",
  fields: [
    S("containerName", "containerName", { path: "containerName", placeholder: "backend", hint: "What kubectl logs -c and the container label on kubelet metrics match on. Defaults to the release name." }),
    TX("command", "command", { placeholder: "/bin/sh\n-c\nexec /app/server", hint: "One list item per line." }),
    TX("args", "args", { placeholder: "--port=8080" }),
    S("workingDir", "workingDir", { path: "workingDir", placeholder: "/app" }),
    N("terminationGracePeriodSeconds", "terminationGracePeriodSeconds", { path: "terminationGracePeriodSeconds", placeholder: "30" }),
    SE("restartPolicy", "restartPolicy (pod)", ["", "Always", "OnFailure", "Never"], { path: "restartPolicy" }),
    SE("containerRestartPolicy", "containerRestartPolicy", ["", "Always", "OnFailure", "Never"], { path: "containerRestartPolicy", hint: "Container-level. Always on an initContainer is what makes it a native sidecar." }),
  ],
  emit: (v) => {
    const o: Values = {};
    put(o, "containerName", v.containerName);
    if (listOf(v.command).length) o.command = listOf(v.command);
    if (listOf(v.args).length) o.args = listOf(v.args);
    put(o, "workingDir", v.workingDir);
    putn(o, "terminationGracePeriodSeconds", v.terminationGracePeriodSeconds);
    put(o, "restartPolicy", v.restartPolicy);
    put(o, "containerRestartPolicy", v.containerRestartPolicy);
    return some(o);
  },
  load: (doc) => ({
    containerName: doc.containerName ?? "",
    command: rowsOf(doc.command).join("\n"),
    args: rowsOf(doc.args).join("\n"),
    workingDir: doc.workingDir ?? "",
    terminationGracePeriodSeconds: doc.terminationGracePeriodSeconds ?? "",
    restartPolicy: doc.restartPolicy ?? "",
    containerRestartPolicy: doc.containerRestartPolicy ?? "",
  }),
});

/* ---------- lookups ---------- */

export const BY_ID: Record<string, FeatureSpec> = Object.fromEntries(FEATURES.map((f) => [f.id, f]));

/** The default state of a feature just switched on: every field at its `def`, lists empty. */
export function defaultValues(id: string): FieldValues {
  const spec = BY_ID[id];
  const v: FieldValues = {};
  spec?.fields.forEach((f) => {
    if (f.def !== undefined) v[f.key] = f.def;
    else if (f.kind === "kv" || f.kind === "rows") v[f.key] = [];
  });
  return v;
}

/** Catalog order, so two documents with the same values produce byte-identical files. */
export function orderKeys(doc: Values): Values {
  const order: string[] = [];
  FEATURES.forEach((f) => f.keys.forEach((k) => { if (!order.includes(k)) order.push(k); }));
  const out: Values = {};
  order.forEach((k) => { if (k in doc) out[k] = doc[k]; });
  Object.keys(doc).forEach((k) => { if (!(k in out)) out[k] = doc[k]; });
  return out;
}

// Re-exported so a feature's emit can reach for them without a second import.
export { clean, flow, raw };
