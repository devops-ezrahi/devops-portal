import { clean, emitNode, flow, raw } from "./yaml";
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

export type RowCol = {
  key: string;
  label: string;
  kind?: "string" | "number" | "boolean" | "select" | "text";
  options?: string[];
  placeholder?: string;
  /** Only shown when the row says so — an exec probe has no `path`, a `value` env var has no `key`. */
  when?: (row: Values) => boolean;
};

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
  /** The label on a `rows` field's add button, e.g. "Add variable". */
  addLabel?: string;
  def?: unknown;
};

export type FeatureSpec = {
  id: string;
  cat: string;
  name: string;
  /** The top-level `values.yaml` keys this feature owns — drives key order and import routing. */
  keys: string[];
  blurb: string;
  /** Cluster-scoped objects: only one release in a cluster may own them. */
  cluster?: boolean;
  fields: FieldSpec[];
  notes?: string[];
  /** Feature state -> a values fragment. Pure; `null` means "contributes nothing". */
  emit: (v: FieldValues) => Values | null;
  /** Values fragment -> feature state. Only needed where `path` cannot say it (rows, kv, lists). */
  load?: (doc: Values) => FieldValues;
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

/** `name=port[:targetPort]` per line — the shape the Service and Route fields take. */
export const parsePorts = (text: unknown): Values | null => {
  const m: Values = {};
  listOf(text).forEach((line) => {
    const [name, rest] = line.split("=");
    if (!name || !rest) return;
    const [port, target] = rest.split(":");
    const o: Values = { port: Number(port) };
    if (nz(target)) o.targetPort = isNaN(Number(target)) ? target : Number(target);
    m[name.trim()] = o;
  });
  return Object.keys(m).length ? m : null;
};

/** `key=value` per line. */
export const parseKV = (text: unknown): Values | null => {
  const m: Values = {};
  listOf(text).forEach((line) => {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return Object.keys(m).length ? m : null;
};

/** The inverse of `parseKV`, for import. */
export const kvLines = (map: unknown): string =>
  isRecord(map) ? Object.entries(map).map(([k, v]) => `${k}=${String(v)}`).join("\n") : "";

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

/* ---------- container ---------- */

F({
  id: "env",
  cat: "container",
  name: "Environment variables",
  keys: ["env"],
  blurb: "A map keyed by variable name, so an override can target env.LOG_LEVEL.value instead of guessing an array index.",
  fields: [
    RW(
      "items",
      "Variables",
      [
        { key: "name", label: "Name", placeholder: "LOG_LEVEL" },
        { key: "kind", label: "Source", kind: "select", options: ["value", "secretKeyRef", "configMapKeyRef", "fieldRef", "resourceFieldRef"] },
        { key: "value", label: "Value", placeholder: "debug", when: (r) => (r.kind || "value") === "value" },
        { key: "ref", label: "Secret / ConfigMap name", placeholder: "db-secret", when: (r) => r.kind === "secretKeyRef" || r.kind === "configMapKeyRef" },
        { key: "key", label: "Key", placeholder: "password", when: (r) => r.kind === "secretKeyRef" || r.kind === "configMapKeyRef" },
        { key: "fieldPath", label: "fieldPath", placeholder: "metadata.name", when: (r) => r.kind === "fieldRef" },
        { key: "resource", label: "resource", placeholder: "limits.memory", when: (r) => r.kind === "resourceFieldRef" },
      ],
      { addLabel: "Add variable" }
    ),
  ],
  emit: (v) =>
    some({
      env: mapOf(v.items, (r) => {
        const k = String(r.kind || "value");
        if (k === "value") return { value: String(r.value ?? "") };
        if (k === "fieldRef") return { valueFrom: { fieldRef: { fieldPath: r.fieldPath } } };
        if (k === "resourceFieldRef") return { valueFrom: { resourceFieldRef: { resource: r.resource } } };
        return { valueFrom: { [k]: { name: r.ref, key: r.key } } };
      }),
    }),
  load: (doc) => ({
    items: Object.entries(isRecord(doc.env) ? doc.env : {}).map(([name, body]) => {
      const b = isRecord(body) ? body : {};
      const from = isRecord(b.valueFrom) ? b.valueFrom : null;
      if (!from) return { name, kind: "value", value: String(b.value ?? "") };
      const kind = Object.keys(from)[0] ?? "value";
      const inner = isRecord(from[kind]) ? (from[kind] as Values) : {};
      return { name, kind, value: "", ref: inner.name ?? "", key: inner.key ?? "", fieldPath: inner.fieldPath ?? "", resource: inner.resource ?? "" };
    }),
  }),
  notes: ["Every value is rendered as a string — Kubernetes rejects a numeric env value, so PORT: 8080 comes out quoted."],
});

F({
  id: "envfrom",
  cat: "container",
  name: "envFrom",
  keys: ["envFrom"],
  blurb: "Pull every key of a ConfigMap or Secret in as environment variables. Keyed by the object name.",
  fields: [
    RW(
      "items",
      "Sources",
      [
        { key: "name", label: "ConfigMap / Secret name", placeholder: "backend-config" },
        { key: "type", label: "Kind", kind: "select", options: ["configMapRef", "secretRef"] },
        { key: "optional", label: "optional", kind: "boolean" },
      ],
      { addLabel: "Add source" }
    ),
  ],
  emit: (v) =>
    some({
      envFrom: mapOf(v.items, (r) => {
        const o: Values = { type: r.type || "configMapRef" };
        if (r.optional) o.optional = true;
        return o;
      }),
    }),
  load: (doc) => ({
    items: Object.entries(isRecord(doc.envFrom) ? doc.envFrom : {}).map(([name, body]) => ({
      name,
      ...(isRecord(body) ? body : {}),
    })),
  }),
});

F({
  id: "ports",
  cat: "container",
  name: "Container ports",
  keys: ["ports"],
  blurb: "Named container ports. The name is what a Service targetPort, a probe and a ServiceMonitor all refer back to.",
  fields: [
    RW(
      "items",
      "Ports",
      [
        { key: "name", label: "Name", placeholder: "http" },
        { key: "port", label: "containerPort", kind: "number", placeholder: "8080" },
        { key: "protocol", label: "Protocol", kind: "select", options: ["", "TCP", "UDP", "SCTP"] },
        { key: "unnamed", label: "unnamed (render with no name)", kind: "boolean" },
      ],
      { addLabel: "Add port" }
    ),
  ],
  emit: (v) =>
    some({
      ports: mapOf(v.items, (r) => {
        const o: Values = {};
        putn(o, "containerPort", r.port);
        put(o, "protocol", r.protocol);
        if (r.unnamed) o.unnamed = true;
        return Object.keys(o).length ? o : null;
      }),
    }),
  load: (doc) => ({
    items: Object.entries(isRecord(doc.ports) ? doc.ports : {}).map(([name, body]) => {
      const b = isRecord(body) ? body : {};
      return { name, port: b.containerPort ?? "", protocol: b.protocol ?? "", unnamed: !!b.unnamed };
    }),
  }),
  notes: ["unnamed: true keeps the map key as bookkeeping but renders the port with no name — for manifests that never named theirs."],
});

F({
  id: "resources",
  cat: "container",
  name: "Resources & GPU",
  keys: ["resources"],
  blurb: "Requests are what the scheduler reserves. Exceeding the memory limit is an OOMKill, not a throttle.",
  fields: [
    S("rcpu", "requests.cpu", { path: "resources.requests.cpu", placeholder: "200m" }),
    S("rmem", "requests.memory", { path: "resources.requests.memory", placeholder: "256Mi" }),
    S("lcpu", "limits.cpu", { path: "resources.limits.cpu", placeholder: "1000m" }),
    S("lmem", "limits.memory", { path: "resources.limits.memory", placeholder: "1Gi" }),
    S("gpu", "nvidia.com/gpu", { placeholder: "1", hint: "Set on both requests and limits. Needs the device plugin on the cluster." }),
  ],
  emit: (v) => {
    const rq: Values = {};
    const lm: Values = {};
    put(rq, "cpu", v.rcpu);
    put(rq, "memory", v.rmem);
    put(lm, "cpu", v.lcpu);
    put(lm, "memory", v.lmem);
    if (nz(v.gpu)) {
      rq["nvidia.com/gpu"] = Number(v.gpu);
      lm["nvidia.com/gpu"] = Number(v.gpu);
    }
    return some({ resources: some({ requests: some(rq), limits: some(lm) }) });
  },
  load: (doc) => {
    const r = isRecord(doc.resources) ? doc.resources : {};
    const rq = isRecord(r.requests) ? r.requests : {};
    const lm = isRecord(r.limits) ? r.limits : {};
    return { rcpu: rq.cpu ?? "", rmem: rq.memory ?? "", lcpu: lm.cpu ?? "", lmem: lm.memory ?? "", gpu: rq["nvidia.com/gpu"] ?? "" };
  },
});

F({
  id: "probes",
  cat: "container",
  name: "Probes",
  keys: ["livenessProbe", "readinessProbe", "startupProbe"],
  blurb: "Liveness restarts the container, readiness pulls it out of the Service, startup buys a slow app time before either applies.",
  fields: [
    RW(
      "items",
      "Probes",
      [
        { key: "which", label: "Probe", kind: "select", options: ["readinessProbe", "livenessProbe", "startupProbe"] },
        { key: "kind", label: "Type", kind: "select", options: ["httpGet", "tcpSocket", "exec", "grpc"] },
        { key: "path", label: "path", placeholder: "/healthz", when: (r) => (r.kind || "httpGet") === "httpGet" },
        { key: "port", label: "port", placeholder: "http", when: (r) => (r.kind || "httpGet") !== "exec" },
        { key: "svc", label: "grpc service", placeholder: "liveness", when: (r) => r.kind === "grpc" },
        { key: "command", label: "command", kind: "text", placeholder: "/bin/sh\n-c\npg_isready -U postgres", when: (r) => r.kind === "exec" },
        { key: "initialDelaySeconds", label: "initialDelaySeconds", kind: "number", placeholder: "10" },
        { key: "periodSeconds", label: "periodSeconds", kind: "number", placeholder: "10" },
        { key: "timeoutSeconds", label: "timeoutSeconds", kind: "number", placeholder: "5" },
        { key: "failureThreshold", label: "failureThreshold", kind: "number", placeholder: "3" },
      ],
      { addLabel: "Add probe" }
    ),
  ],
  emit: (v) => {
    const o: Values = {};
    rowsOf(v.items).forEach((r) => {
      const which = String(r.which || "readinessProbe");
      const kind = String(r.kind || "httpGet");
      const port = isNaN(Number(r.port)) ? r.port : Number(r.port);
      const p: Values = {};
      if (kind === "httpGet") p.httpGet = clean({ path: r.path, port });
      else if (kind === "tcpSocket") p.tcpSocket = clean({ port });
      else if (kind === "grpc") p.grpc = clean({ port: Number(r.port), service: r.svc });
      else p.exec = { command: listOf(r.command) };
      putn(p, "initialDelaySeconds", r.initialDelaySeconds);
      putn(p, "periodSeconds", r.periodSeconds);
      putn(p, "timeoutSeconds", r.timeoutSeconds);
      putn(p, "failureThreshold", r.failureThreshold);
      o[which] = p;
    });
    return some(o);
  },
  load: (doc) => ({
    items: (["readinessProbe", "livenessProbe", "startupProbe"] as const)
      .filter((which) => isRecord(doc[which]))
      .map((which) => {
        const p = doc[which] as Values;
        const kind = (["httpGet", "tcpSocket", "grpc", "exec"] as const).find((k) => isRecord(p[k])) ?? "httpGet";
        const body = isRecord(p[kind]) ? (p[kind] as Values) : {};
        return {
          which,
          kind,
          path: body.path ?? "",
          port: body.port ?? "",
          svc: body.service ?? "",
          command: rowsOf(body.command).join("\n"),
          initialDelaySeconds: p.initialDelaySeconds ?? "",
          periodSeconds: p.periodSeconds ?? "",
          timeoutSeconds: p.timeoutSeconds ?? "",
          failureThreshold: p.failureThreshold ?? "",
        };
      }),
  }),
  notes: [
    "A startup probe with failureThreshold x periodSeconds too low is a crashloop, not a slow start. 30 x 10s = five minutes of grace.",
  ],
});

F({
  id: "restartrules",
  cat: "container",
  name: "Container restart rules",
  keys: ["containerRestartRules"],
  blurb: "In-place restart on a specific exit code — the pod keeps its UID, IP, network namespace and volumes.",
  fields: [
    RW(
      "items",
      "Rules",
      [
        { key: "exitCode", label: "exitCode", kind: "number", placeholder: "139" },
        { key: "action", label: "action", kind: "select", options: ["RestartAllContainers"] },
      ],
      { addLabel: "Add rule" }
    ),
  ],
  emit: (v) =>
    some({
      containerRestartRules: rowsOf(v.items)
        .filter((r) => nz(r.exitCode))
        .map((r) => ({ exitCode: Number(r.exitCode), action: r.action || "RestartAllContainers" })),
    }),
  load: (doc) => ({ items: rowsOf(doc.containerRestartRules) }),
  notes: [
    "Requires Kubernetes 1.35+ with the RestartAllContainersOnContainerExits feature gate (alpha).",
    "Init containers re-run in order on an in-place restart. 137 = OOMKilled/SIGKILL, 139 = SIGSEGV, 143 = SIGTERM.",
    "This key is the main container's. Sidecars and init containers carry their own containerRestartRules in their own spec.",
  ],
});

F({
  id: "lifecycle",
  cat: "container",
  name: "Lifecycle hooks",
  keys: ["lifecycle"],
  blurb: "postStart and preStop hooks, passed through as written.",
  fields: [YA("body", "lifecycle", { placeholder: 'preStop:\n  exec:\n    command: ["/bin/sh","-c","sleep 15"]' })],
  emit: (v) => (nz(v.body) ? { lifecycle: raw(v.body) } : null),
  notes: [
    "A preStop sleep is the usual fix for connections dropped mid-rollout: it holds the container open while the endpoint is removed from every kube-proxy.",
  ],
});

/* ---------- storage ---------- */

const ACCESS = ["ReadWriteOnce", "ReadWriteMany", "ReadOnlyMany", "ReadWriteOncePod"];

F({
  id: "volumes",
  cat: "storage",
  name: "Volumes",
  keys: ["volumes"],
  blurb: "Define the volume here, mount it in the next section. Keyed by volume name, which is what the mount refers to.",
  fields: [
    RW(
      "items",
      "Volumes",
      [
        { key: "name", label: "Name", placeholder: "nginx-conf" },
        { key: "kind", label: "Type", kind: "select", options: ["configMap", "secret", "emptyDir", "emptyDir (memory)", "persistentVolumeClaim", "hostPath", "nfs", "custom"] },
        { key: "src", label: "Source name", placeholder: "nginx-config", when: (r) => ["configMap", "secret", "persistentVolumeClaim"].includes(String(r.kind || "configMap")) },
        { key: "defaultMode", label: "defaultMode", placeholder: "0644", when: (r) => ["configMap", "secret"].includes(String(r.kind || "configMap")) },
        { key: "sizeLimit", label: "sizeLimit", placeholder: "512Mi", when: (r) => String(r.kind ?? "").startsWith("emptyDir") },
        { key: "path", label: "path", placeholder: "/exports/myapp", when: (r) => ["hostPath", "nfs"].includes(String(r.kind)) },
        { key: "server", label: "NFS server", placeholder: "nfs.internal.example.com", when: (r) => r.kind === "nfs" },
        { key: "body", label: "Volume source YAML", kind: "text", placeholder: "csi:\n  driver: secrets-store.csi.k8s.io\n  readOnly: true", when: (r) => r.kind === "custom" },
      ],
      { addLabel: "Add volume" }
    ),
  ],
  emit: (v) =>
    some({
      volumes: mapOf(v.items, (r) => {
        const k = String(r.kind || "configMap");
        const mode = nz(r.defaultMode) ? Number(r.defaultMode) : undefined;
        if (k === "configMap") return { configMap: clean({ name: r.src, defaultMode: mode }) };
        if (k === "secret") return { secret: clean({ secretName: r.src, defaultMode: mode }) };
        if (k === "emptyDir") return { emptyDir: nz(r.sizeLimit) ? { sizeLimit: r.sizeLimit } : {} };
        if (k === "emptyDir (memory)") return { emptyDir: clean({ medium: "Memory", sizeLimit: r.sizeLimit }) };
        if (k === "persistentVolumeClaim") return { persistentVolumeClaim: { claimName: r.src } };
        if (k === "hostPath") return { hostPath: { path: r.path } };
        if (k === "nfs") return { nfs: clean({ server: r.server, path: r.path }) };
        return nz(r.body) ? (raw(r.body) as unknown as Values) : null;
      }),
    }),
  notes: ["defaultMode is octal in Kubernetes but a number in YAML — 0644 is written unquoted so it stays one."],
});

F({
  id: "mounts",
  cat: "storage",
  name: "Volume mounts",
  keys: ["volumeMounts"],
  blurb: "Where each volume lands in the container. subPath mounts a single key instead of the whole volume.",
  fields: [
    RW(
      "items",
      "Mounts",
      [
        { key: "name", label: "Volume name", placeholder: "nginx-conf" },
        { key: "mountPath", label: "mountPath", placeholder: "/etc/nginx/conf.d" },
        { key: "subPath", label: "subPath", placeholder: "nginx.conf" },
        { key: "readOnly", label: "readOnly", kind: "boolean" },
      ],
      { addLabel: "Add mount" }
    ),
  ],
  emit: (v) =>
    some({
      volumeMounts: mapOf(v.items, (r) => {
        const o: Values = {};
        put(o, "mountPath", r.mountPath);
        put(o, "subPath", r.subPath);
        if (r.readOnly) o.readOnly = true;
        return Object.keys(o).length ? o : null;
      }),
    }),
  load: (doc) => ({
    items: Object.entries(isRecord(doc.volumeMounts) ? doc.volumeMounts : {}).map(([name, body]) => ({
      name,
      ...(isRecord(body) ? body : {}),
    })),
  }),
  notes: ["Mounting a whole ConfigMap over /etc/nginx hides everything already in that directory. Use subPath to drop in one file."],
});

F({
  id: "pvc",
  cat: "storage",
  name: "PersistentVolumeClaims",
  keys: ["pvc"],
  blurb: "Standalone claims created as their own objects — the Deployment pattern. One PVC shared by every replica.",
  fields: [
    RW(
      "items",
      "Claims",
      [
        { key: "name", label: "Name", placeholder: "app-data" },
        { key: "size", label: "size", placeholder: "50Gi" },
        { key: "accessMode", label: "accessMode", kind: "select", options: ACCESS },
        { key: "storageClassName", label: "storageClassName", placeholder: "fast-ssd" },
        { key: "volumeMode", label: "volumeMode", kind: "select", options: ["", "Filesystem", "Block"] },
        { key: "volumeName", label: "volumeName (bind to one PV)" },
      ],
      { addLabel: "Add PVC" }
    ),
  ],
  emit: (v) =>
    some({
      pvc: mapOf(v.items, (r) => {
        const o: Values = { accessModes: flow([r.accessMode || "ReadWriteOnce"]) };
        put(o, "size", r.size);
        put(o, "storageClassName", r.storageClassName);
        put(o, "volumeMode", r.volumeMode);
        put(o, "volumeName", r.volumeName);
        return o;
      }),
    }),
  notes: [
    "ReadWriteOnce with more than one replica means the second pod never schedules. Use ReadWriteMany (NFS/CephFS) or a StatefulSet with volumeClaimTemplates.",
  ],
});

F({
  id: "vct",
  cat: "storage",
  name: "volumeClaimTemplates",
  keys: ["volumeClaimTemplates", "persistentVolumeClaimRetentionPolicy"],
  blurb: "StatefulSet only: one PVC set per replica, named <template>-<pod>. This is how databases get storage.",
  fields: [
    RW(
      "items",
      "Templates",
      [
        { key: "name", label: "Name", placeholder: "data" },
        { key: "size", label: "size", placeholder: "100Gi" },
        { key: "accessMode", label: "accessMode", kind: "select", options: ACCESS },
        { key: "storageClassName", label: "storageClassName", placeholder: "fast-ssd" },
      ],
      { addLabel: "Add template" }
    ),
    SE("whenDeleted", "retention: whenDeleted", ["", "Retain", "Delete"], { path: "persistentVolumeClaimRetentionPolicy.whenDeleted" }),
    SE("whenScaled", "retention: whenScaled", ["", "Retain", "Delete"], { path: "persistentVolumeClaimRetentionPolicy.whenScaled" }),
  ],
  emit: (v) =>
    some({
      volumeClaimTemplates: mapOf(v.items, (r) => {
        const o: Values = { accessModes: flow([r.accessMode || "ReadWriteOnce"]) };
        put(o, "size", r.size);
        put(o, "storageClassName", r.storageClassName);
        return o;
      }),
      persistentVolumeClaimRetentionPolicy: some({ whenDeleted: v.whenDeleted, whenScaled: v.whenScaled }),
    }),
  notes: [
    "Kubernetes' own default is Delete on both — scale a StatefulSet down and the data goes with it. Set Retain for anything you cannot re-create.",
    "The chart leaves the retention policy empty on purpose, so the rendered StatefulSet omits the field rather than inventing one.",
  ],
});

F({
  id: "pv",
  cat: "storage",
  name: "PersistentVolumes",
  keys: ["persistentVolumes"],
  cluster: true,
  blurb: "Static provisioning — you supply the storage yourself instead of asking a StorageClass for it. Cluster-scoped.",
  fields: [
    RW(
      "items",
      "Volumes",
      [
        { key: "name", label: "Name", placeholder: "local-ssd-node1" },
        { key: "capacity", label: "capacity", placeholder: "200Gi" },
        { key: "accessMode", label: "accessMode", kind: "select", options: ACCESS },
        { key: "reclaimPolicy", label: "reclaimPolicy", kind: "select", options: ["", "Retain", "Delete", "Recycle"] },
        { key: "storageClassName", label: "storageClassName", placeholder: "local-storage" },
        { key: "body", label: "Source + nodeAffinity", kind: "text", placeholder: "local:\n  path: /mnt/ssd" },
      ],
      { addLabel: "Add PV" }
    ),
  ],
  emit: (v) =>
    some({
      persistentVolumes: mapOf(v.items, (r) => {
        // Written as a raw block: a PV's source is one of thirty shapes, and
        // the chart passes whatever is here straight through.
        const t: string[] = [];
        if (nz(r.capacity)) t.push(`capacity: ${r.capacity}`);
        t.push(`accessModes: [${r.accessMode || "ReadWriteOnce"}]`);
        if (nz(r.reclaimPolicy)) t.push(`reclaimPolicy: ${r.reclaimPolicy}`);
        if (nz(r.storageClassName)) t.push(`storageClassName: ${r.storageClassName}`);
        if (nz(r.body)) t.push(String(r.body).replace(/\s+$/, ""));
        return raw(t.join("\n")) as unknown as Values;
      }),
    }),
  notes: [
    "Cluster-scoped. Two releases in different namespaces defining the same PV name are fighting over one object — deploy it once, from a shared release.",
  ],
});

F({
  id: "storageclass",
  cat: "storage",
  name: "StorageClasses",
  keys: ["storageClasses"],
  cluster: true,
  blurb: "What a PVC asks for by name. Cluster-scoped, so this belongs in a platform release, not in every microservice.",
  fields: [
    RW(
      "items",
      "Classes",
      [
        { key: "name", label: "Name", placeholder: "fast-ssd" },
        { key: "provisioner", label: "provisioner", placeholder: "ebs.csi.aws.com" },
        { key: "reclaimPolicy", label: "reclaimPolicy", kind: "select", options: ["", "Delete", "Retain"] },
        { key: "volumeBindingMode", label: "volumeBindingMode", kind: "select", options: ["", "Immediate", "WaitForFirstConsumer"] },
        { key: "allowVolumeExpansion", label: "allowVolumeExpansion", kind: "boolean" },
        { key: "parameters", label: "parameters (key=value per line)", kind: "text", placeholder: "type=gp3\niops=16000" },
      ],
      { addLabel: "Add class" }
    ),
  ],
  emit: (v) =>
    some({
      storageClasses: mapOf(v.items, (r) => {
        const o: Values = {};
        put(o, "provisioner", r.provisioner);
        put(o, "reclaimPolicy", r.reclaimPolicy);
        put(o, "volumeBindingMode", r.volumeBindingMode);
        if (r.allowVolumeExpansion) o.allowVolumeExpansion = true;
        const p = parseKV(r.parameters);
        if (p) o.parameters = p;
        return some(o);
      }),
    }),
  notes: [
    "WaitForFirstConsumer delays provisioning until a pod is scheduled, so the volume lands in the same zone as the pod. On a multi-AZ cluster, Immediate is how you get a pod that can never schedule.",
  ],
});

/* ---------- networking ---------- */

F({
  id: "service",
  cat: "network",
  name: "Service",
  keys: ["service"],
  blurb: "The primary Service in front of these pods. clusterIP: None makes it headless, which is what gives StatefulSet pods per-pod DNS.",
  fields: [
    B("enabled", "enabled", { def: true, path: "service.enabled" }),
    SE("type", "type", ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"], { def: "ClusterIP", path: "service.type" }),
    S("name", "name", { path: "service.name", hint: "Render the Service under a real name instead of the release fullname." }),
    TX("ports", "ports", { placeholder: "http=80:http\nmetrics=9091:metrics", hint: "name=port:targetPort, one per line. targetPort may be a container port name." }),
    S("clusterIP", "clusterIP", { path: "service.clusterIP", placeholder: "None" }),
    S("externalName", "externalName", { path: "service.externalName", placeholder: "my.database.example.com" }),
    SE("sessionAffinity", "sessionAffinity", ["", "None", "ClientIP"], { path: "service.sessionAffinity" }),
    SE("externalTrafficPolicy", "externalTrafficPolicy", ["", "Cluster", "Local"], { path: "service.externalTrafficPolicy" }),
    B("publishNotReadyAddresses", "publishNotReadyAddresses", { path: "service.publishNotReadyAddresses" }),
    KV("annotations", "annotations"),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    put(o, "type", v.type);
    put(o, "name", v.name);
    const p = parsePorts(v.ports);
    if (p) o.ports = p;
    put(o, "clusterIP", v.clusterIP);
    put(o, "externalName", v.externalName);
    put(o, "sessionAffinity", v.sessionAffinity);
    put(o, "externalTrafficPolicy", v.externalTrafficPolicy);
    if (v.publishNotReadyAddresses) o.publishNotReadyAddresses = true;
    const a = kvOf(v.annotations);
    if (a) o.annotations = a;
    return { service: o };
  },
  load: (doc) => {
    const s = isRecord(doc.service) ? doc.service : {};
    const ports = isRecord(s.ports) ? s.ports : {};
    return {
      enabled: s.enabled !== false,
      type: s.type ?? "",
      name: s.name ?? "",
      ports: Object.entries(ports)
        .map(([name, body]) => {
          const b = isRecord(body) ? body : {};
          return `${name}=${b.port ?? ""}${nz(b.targetPort) ? `:${b.targetPort}` : ""}`;
        })
        .join("\n"),
      clusterIP: s.clusterIP ?? "",
      externalName: s.externalName ?? "",
      sessionAffinity: s.sessionAffinity ?? "",
      externalTrafficPolicy: s.externalTrafficPolicy ?? "",
      publishNotReadyAddresses: !!s.publishNotReadyAddresses,
      annotations: pairsOf(s.annotations),
    };
  },
  notes: [
    "ExternalName drops the selector automatically — Kubernetes rejects a Service that has both.",
    "A headless Service for a clustered database usually also wants publishNotReadyAddresses: true, or peers can never find each other during formation.",
  ],
});

F({
  id: "services",
  cat: "network",
  name: "Extra Services",
  keys: ["services"],
  blurb: "Additional Service objects beyond the primary one — an admin-only port, a headless peer-discovery Service, a shim pointing at someone else's pods.",
  fields: [
    RW(
      "items",
      "Services",
      [
        { key: "name", label: "Name", placeholder: "admin" },
        { key: "type", label: "type", kind: "select", options: ["", "ClusterIP", "NodePort", "LoadBalancer"] },
        { key: "ports", label: "ports", kind: "text", placeholder: "admin-http=8081:8081" },
        { key: "clusterIP", label: "clusterIP", placeholder: "None" },
        { key: "publishNotReadyAddresses", label: "publishNotReadyAddresses", kind: "boolean" },
        { key: "selector", label: "selector (key=value per line)", kind: "text", placeholder: "app=legacy-app" },
      ],
      { addLabel: "Add Service" }
    ),
  ],
  emit: (v) =>
    some({
      services: mapOf(v.items, (r) => {
        // Every entry carries its own `enabled: true` — unlike the primary
        // Service, an entry that omits it is simply not rendered.
        const o: Values = { enabled: true };
        put(o, "type", r.type);
        const p = parsePorts(r.ports);
        if (p) o.ports = p;
        put(o, "clusterIP", r.clusterIP);
        if (r.publishNotReadyAddresses) o.publishNotReadyAddresses = true;
        const s = parseKV(r.selector);
        if (s) o.selector = s;
        return o;
      }),
    }),
  notes: ["The map key is the object name verbatim, so it has to be unique in the namespace."],
});

F({
  id: "ingress",
  cat: "network",
  name: "Ingress",
  keys: ["ingress"],
  blurb: "Standard Kubernetes Ingress. Each path points at a named Service port via portName.",
  fields: [
    B("enabled", "enabled", { def: true, path: "ingress.enabled" }),
    S("className", "className", { placeholder: "nginx", path: "ingress.className" }),
    KV("annotations", "annotations"),
    RW(
      "hosts",
      "Hosts & paths",
      [
        { key: "host", label: "host", placeholder: "api.example.com" },
        { key: "path", label: "path", placeholder: "/" },
        { key: "pathType", label: "pathType", kind: "select", options: ["Prefix", "Exact", "ImplementationSpecific"] },
        { key: "portName", label: "portName", placeholder: "http" },
      ],
      { addLabel: "Add path" }
    ),
    RW(
      "tls",
      "TLS",
      [
        { key: "secretName", label: "secretName", placeholder: "api-tls" },
        { key: "hosts", label: "hosts (comma separated)", placeholder: "api.example.com" },
      ],
      { addLabel: "Add TLS entry" }
    ),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    put(o, "className", v.className);
    const a = kvOf(v.annotations);
    if (a) o.annotations = a;
    // Paths on the same host are grouped into one rule — they are added here as
    // separate lines, which is how anyone thinks about them.
    const byHost: { host: string; paths: Values[] }[] = [];
    rowsOf(v.hosts).forEach((r) => {
      if (!nz(r.host)) return;
      let h = byHost.find((x) => x.host === r.host);
      if (!h) {
        h = { host: String(r.host), paths: [] };
        byHost.push(h);
      }
      h.paths.push(clean({ path: r.path || "/", pathType: r.pathType || "Prefix", portName: r.portName }));
    });
    if (byHost.length) o.hosts = byHost;
    const tls = rowsOf(v.tls)
      .filter((r) => nz(r.secretName))
      .map((r) =>
        clean({
          secretName: r.secretName,
          hosts: flow(
            String(r.hosts ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          ),
        })
      );
    if (tls.length) o.tls = tls;
    return { ingress: o };
  },
  load: (doc) => {
    const i = isRecord(doc.ingress) ? doc.ingress : {};
    return {
      enabled: i.enabled !== false,
      className: i.className ?? "",
      annotations: pairsOf(i.annotations),
      hosts: rowsOf(i.hosts).flatMap((h) => rowsOf(h.paths).map((p) => ({ host: h.host, ...p }))),
      tls: rowsOf(i.tls).map((t) => ({ secretName: t.secretName, hosts: rowsOf(t.hosts).join(", ") })),
    };
  },
  notes: ["Paths on the same host are grouped into one rule automatically — add them as separate lines here."],
});

F({
  id: "route",
  cat: "network",
  name: "OpenShift Route",
  keys: ["route"],
  blurb: "The OpenShift equivalent of an Ingress. Leave host empty and the router assigns one.",
  fields: [
    B("enabled", "enabled", { def: true, path: "route.enabled" }),
    S("host", "host", { path: "route.host", placeholder: "myapp.apps.cluster.example.com" }),
    S("path", "path", { path: "route.path", placeholder: "/" }),
    S("targetPort", "targetPort", { path: "route.targetPort", placeholder: "http" }),
    SE("termination", "tls.termination", ["edge", "passthrough", "reencrypt"], { def: "edge", path: "route.tls.termination" }),
    SE("insecure", "tls.insecureEdgeTerminationPolicy", ["", "Redirect", "Allow", "None"], { def: "Redirect", path: "route.tls.insecureEdgeTerminationPolicy" }),
    KV("annotations", "annotations"),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    put(o, "host", v.host);
    put(o, "path", v.path);
    put(o, "targetPort", v.targetPort);
    const t: Values = {};
    put(t, "termination", v.termination);
    put(t, "insecureEdgeTerminationPolicy", v.insecure);
    if (Object.keys(t).length) o.tls = t;
    const a = kvOf(v.annotations);
    if (a) o.annotations = a;
    return { route: o };
  },
  load: (doc) => {
    const r = isRecord(doc.route) ? doc.route : {};
    const tls = isRecord(r.tls) ? r.tls : {};
    return {
      enabled: r.enabled !== false,
      host: r.host ?? "",
      path: r.path ?? "",
      targetPort: r.targetPort ?? "",
      termination: tls.termination ?? "",
      insecure: tls.insecureEdgeTerminationPolicy ?? "",
      annotations: pairsOf(r.annotations),
    };
  },
  notes: [
    'An empty host is omitted from the manifest, not rendered as host: "" — which OpenShift would reject.',
    "passthrough means the pod terminates TLS itself; there is no certificate on the Route.",
  ],
});

F({
  id: "routes",
  cat: "network",
  name: "Extra Routes",
  keys: ["routes"],
  blurb: "More hostnames or paths in front of the same pods — or in front of a different Service entirely.",
  fields: [
    RW(
      "items",
      "Routes",
      [
        { key: "name", label: "Name", placeholder: "admin-console" },
        { key: "host", label: "host", placeholder: "admin.apps.cluster.example.com" },
        { key: "path", label: "path" },
        { key: "targetPort", label: "targetPort", placeholder: "admin-http" },
        { key: "serviceName", label: "serviceName", placeholder: "admin" },
        { key: "termination", label: "termination", kind: "select", options: ["", "edge", "passthrough", "reencrypt"] },
      ],
      { addLabel: "Add Route" }
    ),
  ],
  emit: (v) =>
    some({
      routes: mapOf(v.items, (r) => {
        const o: Values = { enabled: true };
        put(o, "host", r.host);
        put(o, "path", r.path);
        put(o, "targetPort", r.targetPort);
        put(o, "serviceName", r.serviceName);
        if (nz(r.termination)) o.tls = { termination: r.termination };
        return o;
      }),
    }),
  notes: [
    "serviceName defaults to this release's own Service; targetPort defaults to the first port on it. wildcardPolicy defaults to None.",
  ],
});

F({
  id: "netpol",
  cat: "network",
  name: "NetworkPolicies",
  keys: ["networkPolicies"],
  blurb: "Pod-level firewall rules. Keyed by policy name; the body is passed through as written.",
  fields: [
    RW(
      "items",
      "Policies",
      [
        { key: "name", label: "Name", placeholder: "backend-allow-from-frontend" },
        { key: "body", label: "Policy spec", kind: "text", placeholder: "podSelector:\n  matchLabels:\n    app.kubernetes.io/name: backend\npolicyTypes: [Ingress]" },
      ],
      { addLabel: "Add policy" }
    ),
  ],
  emit: (v) => some({ networkPolicies: mapOf(v.items, (r) => (nz(r.body) ? (raw(r.body) as unknown as Values) : null)) }),
  notes: [
    "An egress policy that forgets UDP 53 breaks DNS for the whole pod, which looks like every dependency being down at once.",
  ],
});

/* ---------- config & secrets ---------- */

F({
  id: "configmaps",
  cat: "config",
  name: "ConfigMaps",
  keys: ["configMaps"],
  blurb: "Real ConfigMap objects. Key-value settings, whole config files, or both in the same object.",
  fields: [
    RW(
      "items",
      "ConfigMaps",
      [
        { key: "name", label: "Name", placeholder: "app-config" },
        { key: "data", label: "data (key=value per line)", kind: "text", placeholder: "LOG_LEVEL=info\nMAX_CONNECTIONS=100" },
        { key: "fileName", label: "file key", placeholder: "nginx.conf" },
        { key: "fileBody", label: "file contents", kind: "text", placeholder: "server {\n  listen 80;\n}" },
      ],
      { addLabel: "Add ConfigMap" }
    ),
  ],
  emit: (v) =>
    some({
      configMaps: mapOf(v.items, (r) => {
        const d = parseKV(r.data) ?? {};
        if (nz(r.fileName) && nz(r.fileBody)) d[String(r.fileName)] = `${String(r.fileBody).replace(/\s*$/, "")}\n`;
        return Object.keys(d).length ? { data: d } : null;
      }),
    }),
  notes: [
    'Every value is a string. MAX_CONNECTIONS=100 is written as "100" — Kubernetes rejects a bare number here.',
    "Changing a ConfigMap does not restart pods by default — see Checksums.",
  ],
});

F({
  id: "secrets",
  cat: "config",
  name: "Secrets",
  keys: ["secrets"],
  blurb: "Real Secret objects. stringData takes plain text and Kubernetes base64s it for you.",
  fields: [
    RW(
      "items",
      "Secrets",
      [
        { key: "name", label: "Name", placeholder: "db-secret" },
        { key: "type", label: "type", placeholder: "Opaque | kubernetes.io/tls | kubernetes.io/dockerconfigjson" },
        { key: "stringData", label: "stringData (key=value per line)", kind: "text", placeholder: "DB_PASSWORD=super-secret" },
        { key: "data", label: "data (key=base64 per line)", kind: "text" },
      ],
      { addLabel: "Add Secret" }
    ),
  ],
  emit: (v) =>
    some({
      secrets: mapOf(v.items, (r) => {
        const o: Values = {};
        put(o, "type", r.type);
        const sd = parseKV(r.stringData);
        if (sd) o.stringData = sd;
        const d = parseKV(r.data);
        if (d) o.data = d;
        return Object.keys(o).length ? o : null;
      }),
    }),
  notes: [
    "These values live in the values file, which is in git. For anything that belongs in a secrets manager use ExternalSecrets instead — the chart renders the CRs and ESO produces the Secret.",
  ],
});

F({
  id: "secretstores",
  cat: "config",
  name: "SecretStores",
  keys: ["secretStores", "clusterSecretStores", "externalSecretsApiVersion"],
  cluster: true,
  blurb: "Where a namespace pulls secrets from. Skip this entirely if your platform team already manages a shared store.",
  fields: [
    RW(
      "items",
      "Stores",
      [
        { key: "name", label: "Name", placeholder: "vault-backend" },
        { key: "scope", label: "Scope", kind: "select", options: ["SecretStore", "ClusterSecretStore"] },
        { key: "body", label: "provider", kind: "text", placeholder: "vault:\n  server: https://vault.example.com:8200\n  path: secret" },
      ],
      { addLabel: "Add store" }
    ),
    S("apiVersion", "externalSecretsApiVersion", {
      path: "externalSecretsApiVersion",
      placeholder: "external-secrets.io/v1",
      hint: "Override once at the top level for an older ESO on v1beta1.",
    }),
  ],
  emit: (v) => {
    const ns: Values = {};
    const cs: Values = {};
    rowsOf(v.items).forEach((r) => {
      if (!nz(r.name) || !nz(r.body)) return;
      (r.scope === "ClusterSecretStore" ? cs : ns)[String(r.name)] = { provider: raw(r.body) };
    });
    return some({
      externalSecretsApiVersion: v.apiVersion,
      secretStores: Object.keys(ns).length ? ns : null,
      clusterSecretStores: Object.keys(cs).length ? cs : null,
    });
  },
  notes: [
    "The ESO CRDs must already be installed. This chart renders the custom resources; it does not install the operator.",
    "ClusterSecretStore is cluster-scoped — one owner only. Declaring it per microservice means every release fights over the same object.",
  ],
});

F({
  id: "externalsecrets",
  cat: "config",
  name: "ExternalSecrets",
  keys: ["externalSecrets"],
  blurb: "Sync remote keys into a real Kubernetes Secret. env, envFrom and volumes then treat it like any other Secret.",
  fields: [
    RW(
      "items",
      "ExternalSecrets",
      [
        { key: "name", label: "Name", placeholder: "db-credentials" },
        { key: "store", label: "secretStoreRef.name", placeholder: "vault-backend" },
        { key: "storeKind", label: "secretStoreRef.kind", kind: "select", options: ["SecretStore", "ClusterSecretStore"] },
        { key: "refreshInterval", label: "refreshInterval", placeholder: "1h" },
        { key: "target", label: "target.name (defaults to the map key)" },
        { key: "data", label: "data — secretKey=remoteKey#property per line", kind: "text", placeholder: "password=secret/data/myapp/db#password" },
        { key: "dataFrom", label: "dataFrom.extract.key", placeholder: "secret/data/myapp/all" },
      ],
      { addLabel: "Add ExternalSecret" }
    ),
  ],
  emit: (v) =>
    some({
      externalSecrets: mapOf(v.items, (r) => {
        const o: Values = {};
        if (nz(r.store)) o.secretStoreRef = clean({ name: r.store, kind: r.storeKind });
        put(o, "refreshInterval", r.refreshInterval);
        if (nz(r.target)) o.target = { name: r.target };
        const d = listOf(r.data)
          .map((line) => {
            const [secretKey, rest] = line.split("=");
            if (!rest) return null;
            const [key, property] = rest.split("#");
            return { secretKey: secretKey.trim(), remoteRef: clean({ key: key.trim(), property: property?.trim() }) };
          })
          .filter(Boolean) as Values[];
        if (d.length) o.data = d;
        if (nz(r.dataFrom)) o.dataFrom = [{ extract: { key: r.dataFrom } }];
        return Object.keys(o).length ? o : null;
      }),
    }),
  notes: [
    'ESO will not adopt a Secret it did not create unless that Secret carries reconcile.external-secrets.io/managed: "true". Migrating an existing Secret means labelling it first, or the ExternalSecret sits in error while the stale copy stays put.',
  ],
});

F({
  id: "checksums",
  cat: "config",
  name: "Checksums",
  keys: ["checksums"],
  blurb: "Opt-in: hash the ConfigMaps and Secrets into a pod annotation so a config change rolls the pods.",
  fields: [B("enabled", "checksums.enabled", { path: "checksums.enabled" })],
  emit: (v) => ({ checksums: { enabled: !!v.enabled } }),
  notes: [
    "Enable when the app reads config only at startup. Leave off for databases and StatefulSets, for apps that hot-reload, and anywhere Stakater Reloader is already running — otherwise you get a double restart.",
  ],
});

/* ---------- jobs ---------- */

/** `NAME=value` or `NAME@secret:secretName/key`, one per line. */
const jobEnv = (text: unknown): Values | null => {
  const m: Values = {};
  listOf(text).forEach((line) => {
    const s = line.indexOf("@secret:");
    if (s > 0) {
      const name = line.slice(0, s).trim();
      const [secret, key] = line.slice(s + 8).split("/");
      m[name] = { valueFrom: { secretKeyRef: { name: (secret ?? "").trim(), key: (key ?? "").trim() } } };
      return;
    }
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i).trim()] = { value: line.slice(i + 1).trim() };
  });
  return Object.keys(m).length ? m : null;
};

F({
  id: "cronjobs",
  cat: "batch",
  name: "CronJobs",
  keys: ["cronjobs"],
  blurb: "The map key is the CronJob's name, rendered verbatim — no release-name prefix. Use the full name you want the object to have.",
  fields: [
    RW(
      "items",
      "CronJobs",
      [
        { key: "name", label: "Name", placeholder: "db-backup" },
        { key: "schedule", label: "schedule", placeholder: "0 2 * * *" },
        { key: "concurrencyPolicy", label: "concurrencyPolicy", kind: "select", options: ["", "Allow", "Forbid", "Replace"] },
        { key: "suspend", label: "suspend", kind: "boolean" },
        { key: "successfulJobsHistoryLimit", label: "successfulJobsHistoryLimit", kind: "number", placeholder: "3" },
        { key: "failedJobsHistoryLimit", label: "failedJobsHistoryLimit", kind: "number", placeholder: "1" },
        { key: "startingDeadlineSeconds", label: "startingDeadlineSeconds", kind: "number", placeholder: "300" },
        { key: "restartPolicy", label: "jobTemplate.restartPolicy", kind: "select", options: ["", "OnFailure", "Never"] },
        { key: "backoffLimit", label: "jobTemplate.backoffLimit", kind: "number", placeholder: "3" },
        { key: "activeDeadlineSeconds", label: "jobTemplate.activeDeadlineSeconds", kind: "number", placeholder: "3600" },
        { key: "ttl", label: "jobTemplate.ttlSecondsAfterFinished", kind: "number", placeholder: "86400" },
        { key: "containerName", label: "jobTemplate.containerName" },
        { key: "serviceAccountName", label: "jobTemplate.serviceAccountName", placeholder: "backup-sa" },
        { key: "command", label: "jobTemplate.command", kind: "text", placeholder: "/bin/sh\n-c\npg_dump $DATABASE_URL | gzip > /backup/dump.sql.gz" },
        { key: "env", label: "jobTemplate.env — NAME=value or NAME@secret:name/key", kind: "text", placeholder: "DATABASE_URL@secret:db-secret/DATABASE_URL" },
        { key: "imageRepo", label: "jobTemplate.image.repository" },
        { key: "imageTag", label: "jobTemplate.image.tag" },
        { key: "imagePull", label: "jobTemplate.image.pullPolicy", kind: "select", options: ["", "Always", "IfNotPresent", "Never"] },
      ],
      { addLabel: "Add CronJob" }
    ),
  ],
  emit: (v) =>
    some({
      cronjobs: mapOf(v.items, (r) => {
        const o: Values = {};
        put(o, "schedule", r.schedule);
        put(o, "concurrencyPolicy", r.concurrencyPolicy);
        if (r.suspend) o.suspend = true;
        putn(o, "successfulJobsHistoryLimit", r.successfulJobsHistoryLimit);
        putn(o, "failedJobsHistoryLimit", r.failedJobsHistoryLimit);
        putn(o, "startingDeadlineSeconds", r.startingDeadlineSeconds);
        const jt: Values = {};
        put(jt, "restartPolicy", r.restartPolicy);
        putn(jt, "backoffLimit", r.backoffLimit);
        putn(jt, "activeDeadlineSeconds", r.activeDeadlineSeconds);
        putn(jt, "ttlSecondsAfterFinished", r.ttl);
        put(jt, "containerName", r.containerName);
        put(jt, "serviceAccountName", r.serviceAccountName);
        if (listOf(r.command).length) jt.command = listOf(r.command);
        const en = jobEnv(r.env);
        if (en) jt.env = en;
        const im = clean({ repository: r.imageRepo, tag: r.imageTag, pullPolicy: r.imagePull });
        if (Object.keys(im).length) jt.image = im;
        if (Object.keys(jt).length) o.jobTemplate = jt;
        return Object.keys(o).length ? o : null;
      }),
    }),
  notes: [
    "The name is verbatim. The chart used to prepend the release name; it no longer does.",
    "backoffLimit: 0 and successfulJobsHistoryLimit: 0 mean what they say — an explicit zero is honoured, not treated as unset.",
    "jobTemplate.image.pullPolicy does not inherit the workload's.",
  ],
});

F({
  id: "jobs",
  cat: "batch",
  name: "Jobs & ArgoCD hooks",
  keys: ["jobs"],
  blurb: "One-off Jobs, optionally wired as ArgoCD sync hooks so a migration runs before the app rolls.",
  fields: [
    RW(
      "items",
      "Jobs",
      [
        { key: "name", label: "Name", placeholder: "db-migrate" },
        { key: "restartPolicy", label: "restartPolicy", kind: "select", options: ["", "Never", "OnFailure"] },
        { key: "backoffLimit", label: "backoffLimit", kind: "number", placeholder: "1" },
        { key: "activeDeadlineSeconds", label: "activeDeadlineSeconds", kind: "number", placeholder: "600" },
        { key: "ttl", label: "ttlSecondsAfterFinished", kind: "number", placeholder: "3600" },
        { key: "containerName", label: "containerName", placeholder: "migrate" },
        { key: "serviceAccountName", label: "serviceAccountName" },
        { key: "command", label: "command", kind: "text", placeholder: "python\nmanage.py\nmigrate" },
        { key: "env", label: "env", kind: "text", placeholder: "DATABASE_URL@secret:db-secret/DATABASE_URL" },
        { key: "imageRepo", label: "image.repository" },
        { key: "imageTag", label: "image.tag" },
        { key: "hook", label: "argocd hook", kind: "select", options: ["", "PreSync", "Sync", "PostSync", "SyncFail", "Skip"] },
        { key: "hookDelete", label: "hook-delete-policy", kind: "select", options: ["", "BeforeHookCreation", "HookSucceeded", "HookFailed"] },
      ],
      { addLabel: "Add Job" }
    ),
  ],
  emit: (v) =>
    some({
      jobs: mapOf(v.items, (r) => {
        const o: Values = {};
        put(o, "restartPolicy", r.restartPolicy);
        putn(o, "backoffLimit", r.backoffLimit);
        putn(o, "activeDeadlineSeconds", r.activeDeadlineSeconds);
        putn(o, "ttlSecondsAfterFinished", r.ttl);
        put(o, "containerName", r.containerName);
        put(o, "serviceAccountName", r.serviceAccountName);
        if (listOf(r.command).length) o.command = listOf(r.command);
        const en = jobEnv(r.env);
        if (en) o.env = en;
        const im = clean({ repository: r.imageRepo, tag: r.imageTag });
        if (Object.keys(im).length) o.image = im;
        const an: Values = {};
        if (nz(r.hook)) an["argocd.argoproj.io/hook"] = r.hook;
        if (nz(r.hookDelete)) an["argocd.argoproj.io/hook-delete-policy"] = r.hookDelete;
        if (Object.keys(an).length) o.annotations = an;
        return Object.keys(o).length ? o : null;
      }),
    }),
  notes: [
    "A Job's spec is immutable. Edit one and the next apply fails unless the old Job is deleted first — which is exactly what hook-delete-policy: BeforeHookCreation does on every sync.",
  ],
});

/* ---------- scaling & availability ---------- */

F({
  id: "hpa",
  cat: "scale",
  name: "HorizontalPodAutoscaler",
  keys: ["hpa"],
  blurb: "Scale pod count on CPU, memory or a custom metric. When HPA is on, replicaCount stops being the source of truth.",
  fields: [
    B("enabled", "enabled", { def: true, path: "hpa.enabled" }),
    N("minReplicas", "minReplicas", { placeholder: "2", path: "hpa.minReplicas" }),
    N("maxReplicas", "maxReplicas", { placeholder: "20", path: "hpa.maxReplicas" }),
    N("cpu", "CPU target %", { placeholder: "70" }),
    S("mem", "Memory averageValue", { placeholder: "512Mi" }),
    YA("metrics", "Extra metrics", { placeholder: "- type: Pods\n  pods:\n    metric:\n      name: queue_messages_pending" }),
    YA("behavior", "behavior", { placeholder: "scaleUp:\n  stabilizationWindowSeconds: 30" }),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    putn(o, "minReplicas", v.minReplicas);
    putn(o, "maxReplicas", v.maxReplicas);
    const m: Values[] = [];
    if (nz(v.cpu)) m.push({ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: Number(v.cpu) } } });
    if (nz(v.mem)) m.push({ type: "Resource", resource: { name: "memory", target: { type: "AverageValue", averageValue: v.mem } } });
    if (m.length) o.metrics = m;
    // Hand-written metrics are appended to the two the fields build, as one
    // block — a list cannot be half structured and half raw.
    if (nz(v.metrics)) o.metrics = raw((m.length ? `${emitNode(m, 0, []).join("\n")}\n` : "") + String(v.metrics).replace(/\s+$/, ""));
    if (nz(v.behavior)) o.behavior = raw(v.behavior);
    return { hpa: o };
  },
  notes: [
    "Leave replicaCount out once HPA is on. Setting both means every sync resets the replica count to the values-file number and the HPA immediately scales it back.",
    "A CPU-target HPA needs resources.requests.cpu — utilisation is a percentage of the request, and with no request there is nothing to be a percentage of.",
  ],
});

F({
  id: "vpa",
  cat: "scale",
  name: "VerticalPodAutoscaler",
  keys: ["vpa"],
  blurb: "Let Kubernetes learn and re-set this pod's CPU and memory instead of guessing them yourself.",
  fields: [
    B("enabled", "enabled", { def: true, path: "vpa.enabled" }),
    SE("updateMode", "updateMode", ["Off", "Initial", "Recreate", "Auto"], { def: "Auto", path: "vpa.updateMode" }),
    S("containerName", "containerPolicies.containerName", { placeholder: "*" }),
    S("minCpu", "minAllowed.cpu", { placeholder: "50m" }),
    S("minMem", "minAllowed.memory", { placeholder: "64Mi" }),
    S("maxCpu", "maxAllowed.cpu", { placeholder: "4" }),
    S("maxMem", "maxAllowed.memory", { placeholder: "4Gi" }),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    put(o, "updateMode", v.updateMode);
    const cp = clean({
      containerName: v.containerName,
      minAllowed: some({ cpu: v.minCpu, memory: v.minMem }),
      maxAllowed: some({ cpu: v.maxCpu, memory: v.maxMem }),
      controlledResources: flow(["cpu", "memory"]),
    });
    // More than `controlledResources` alone, or there is no policy to write.
    if (Object.keys(cp).length > 1) o.resourcePolicy = { containerPolicies: [cp] };
    return { vpa: o };
  },
  notes: [
    "Do not run VPA and a CPU-target HPA on the same workload. VPA raises the request, which lowers measured utilisation, which makes the HPA scale in — they fight.",
    "updateMode: Off only produces recommendations. That is the safe way to start.",
  ],
});

F({
  id: "pdb",
  cat: "scale",
  name: "PodDisruptionBudget",
  keys: ["pdb"],
  blurb: "How much of this app a node drain is allowed to take down at once. Set one, not both.",
  fields: [
    B("enabled", "enabled", { def: true, path: "pdb.enabled" }),
    S("minAvailable", "minAvailable", { path: "pdb.minAvailable", placeholder: "2  or  50%" }),
    S("maxUnavailable", "maxUnavailable", { path: "pdb.maxUnavailable", placeholder: "1" }),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    // A percentage stays a string; a count becomes a number, which is what the
    // API expects for the integer form.
    if (nz(v.minAvailable)) o.minAvailable = /^\d+$/.test(String(v.minAvailable)) ? Number(v.minAvailable) : v.minAvailable;
    if (nz(v.maxUnavailable)) o.maxUnavailable = /^\d+$/.test(String(v.maxUnavailable)) ? Number(v.maxUnavailable) : v.maxUnavailable;
    return { pdb: o };
  },
  notes: [
    "minAvailable equal to replicaCount blocks every drain forever. The node never finishes cordoning and the cluster upgrade stalls.",
  ],
});

/* ---------- scheduling & security ---------- */

F({
  id: "scheduling",
  cat: "sched",
  name: "Scheduling",
  keys: ["nodeSelector", "tolerations", "topologySpreadConstraints", "priorityClassName", "runtimeClassName", "schedulerName"],
  blurb: "Which nodes these pods are allowed on, and how evenly they spread once they are.",
  fields: [
    KV("nodeSelector", "nodeSelector"),
    YA("tolerations", "tolerations", { placeholder: '- key: nvidia.com/gpu\n  operator: Equal\n  value: "true"\n  effect: NoSchedule' }),
    YA("topology", "topologySpreadConstraints", { placeholder: "- maxSkew: 1\n  topologyKey: kubernetes.io/hostname\n  whenUnsatisfiable: DoNotSchedule" }),
    S("priorityClassName", "priorityClassName", { path: "priorityClassName", placeholder: "high-priority" }),
    S("runtimeClassName", "runtimeClassName", { path: "runtimeClassName", placeholder: "gvisor" }),
    S("schedulerName", "schedulerName", { path: "schedulerName" }),
  ],
  emit: (v) => {
    const o: Values = {};
    const ns = kvOf(v.nodeSelector);
    if (ns) o.nodeSelector = ns;
    if (nz(v.tolerations)) o.tolerations = raw(v.tolerations);
    if (nz(v.topology)) o.topologySpreadConstraints = raw(v.topology);
    put(o, "priorityClassName", v.priorityClassName);
    put(o, "runtimeClassName", v.runtimeClassName);
    put(o, "schedulerName", v.schedulerName);
    return some(o);
  },
  notes: [
    "whenUnsatisfiable: DoNotSchedule keeps pods Pending rather than breaking the spread. ScheduleAnyway is a preference, not a rule.",
  ],
});

F({
  id: "affinity",
  cat: "sched",
  name: "Affinity & anti-affinity",
  keys: ["affinity"],
  blurb: "Keep replicas off the same node, or pin them to a set of nodes. Same key for every workload type.",
  fields: [
    YA("body", "affinity", {
      placeholder:
        "podAntiAffinity:\n  preferredDuringSchedulingIgnoredDuringExecution:\n    - weight: 100\n      podAffinityTerm:\n        labelSelector:\n          matchLabels:\n            app.kubernetes.io/name: myapp\n        topologyKey: kubernetes.io/hostname",
    }),
  ],
  emit: (v) => (nz(v.body) ? { affinity: raw(v.body) } : null),
  notes: [
    "Hard anti-affinity with more replicas than nodes leaves the extras Pending forever. Soft is the right default for most StatefulSets.",
    "Match on app.kubernetes.io/name — that is exactly what this chart sets as the selector label, and its value is your nameOverride.",
  ],
});

F({
  id: "security",
  cat: "sched",
  name: "Security contexts",
  keys: ["podSecurityContext", "securityContext"],
  blurb: "Pod-level settings apply to every container; container-level applies to the main one. Both are what an admission policy checks.",
  fields: [
    B("runAsNonRoot", "pod: runAsNonRoot", { path: "podSecurityContext.runAsNonRoot" }),
    N("runAsUser", "pod: runAsUser", { path: "podSecurityContext.runAsUser", placeholder: "1000" }),
    N("runAsGroup", "pod: runAsGroup", { path: "podSecurityContext.runAsGroup", placeholder: "3000" }),
    N("fsGroup", "pod: fsGroup", { path: "podSecurityContext.fsGroup", placeholder: "2000" }),
    SE("seccomp", "pod: seccompProfile.type", ["", "RuntimeDefault", "Localhost", "Unconfined"], { path: "podSecurityContext.seccompProfile.type" }),
    B("allowPrivilegeEscalation", "container: allowPrivilegeEscalation"),
    B("readOnlyRootFilesystem", "container: readOnlyRootFilesystem", { path: "securityContext.readOnlyRootFilesystem" }),
    S("drop", "container: capabilities.drop", { placeholder: "ALL" }),
    S("add", "container: capabilities.add", { placeholder: "NET_BIND_SERVICE" }),
    B("cRunAsNonRoot", "container: runAsNonRoot", { path: "securityContext.runAsNonRoot" }),
  ],
  emit: (v) => {
    const p: Values = {};
    if (v.runAsNonRoot) p.runAsNonRoot = true;
    putn(p, "runAsUser", v.runAsUser);
    putn(p, "runAsGroup", v.runAsGroup);
    putn(p, "fsGroup", v.fsGroup);
    if (nz(v.seccomp)) p.seccompProfile = { type: v.seccomp };
    const c: Values = {};
    // `false` is the meaningful value here, so it is written whenever the box
    // has been touched either way.
    if (typeof v.allowPrivilegeEscalation === "boolean") c.allowPrivilegeEscalation = v.allowPrivilegeEscalation;
    if (v.readOnlyRootFilesystem) c.readOnlyRootFilesystem = true;
    if (v.cRunAsNonRoot) c.runAsNonRoot = true;
    const caps: Values = {};
    const split = (s: unknown) =>
      String(s ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    if (nz(v.drop)) caps.drop = flow(split(v.drop));
    if (nz(v.add)) caps.add = flow(split(v.add));
    if (Object.keys(caps).length) c.capabilities = caps;
    return some({ podSecurityContext: some(p), securityContext: some(c) });
  },
  notes: [
    "readOnlyRootFilesystem: true needs an emptyDir mounted at /tmp for most runtimes, or the app fails on its first temp file.",
    "OpenShift assigns the UID from the namespace range. Hardcoding runAsUser there is how a pod gets rejected by the SCC it was supposed to match.",
  ],
});

F({
  id: "scc",
  cat: "sched",
  name: "SecurityContextConstraints",
  keys: ["scc"],
  cluster: true,
  blurb: "OpenShift's admission policy object. Keyed by SCC name; the body is passed through as written. Cluster-scoped.",
  fields: [
    RW(
      "items",
      "SCCs",
      [
        { key: "name", label: "Name", placeholder: "restricted-custom" },
        { key: "body", label: "SCC body", kind: "text", placeholder: "allowPrivilegedContainer: false\nrunAsUser:\n  type: MustRunAsRange" },
      ],
      { addLabel: "Add SCC" }
    ),
  ],
  emit: (v) => some({ scc: mapOf(v.items, (r) => (nz(r.body) ? (raw(r.body) as unknown as Values) : null)) }),
  notes: [
    "Strategy types: MustRunAsRange (project default), MustRunAs, MustRunAsNonRoot, RunAsAny.",
    "Cluster-scoped. Grant it to a ServiceAccount through users:, and own it from one release only.",
  ],
});

F({
  id: "hostns",
  cat: "sched",
  name: "Host namespaces & DNS",
  keys: ["hostNetwork", "hostIPC", "hostPID", "shareProcessNamespace", "dnsPolicy", "dnsConfig", "hostAliases"],
  blurb: "The node-level switches. Node agents need them; almost nothing else does.",
  fields: [
    B("hostNetwork", "hostNetwork", { path: "hostNetwork" }),
    B("hostPID", "hostPID", { path: "hostPID" }),
    B("hostIPC", "hostIPC", { path: "hostIPC" }),
    B("shareProcessNamespace", "shareProcessNamespace", { path: "shareProcessNamespace" }),
    SE("dnsPolicy", "dnsPolicy", ["", "ClusterFirst", "ClusterFirstWithHostNet", "Default", "None"], { path: "dnsPolicy" }),
    YA("dnsConfig", "dnsConfig", { placeholder: "nameservers:\n  - 10.0.0.10" }),
    YA("hostAliases", "hostAliases", { placeholder: "- ip: 10.0.0.5\n  hostnames:\n    - legacy.internal" }),
  ],
  emit: (v) => {
    const o: Values = {};
    (["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"] as const).forEach((k) => {
      if (v[k]) o[k] = true;
    });
    put(o, "dnsPolicy", v.dnsPolicy);
    if (nz(v.dnsConfig)) o.dnsConfig = raw(v.dnsConfig);
    if (nz(v.hostAliases)) o.hostAliases = raw(v.hostAliases);
    return some(o);
  },
  notes: [
    "hostNetwork: true without dnsPolicy: ClusterFirstWithHostNet gives the pod the node's resolver, so every in-cluster Service name stops resolving.",
  ],
});

/* ---------- identity & observability ---------- */

F({
  id: "serviceaccount",
  cat: "ops",
  name: "ServiceAccount",
  keys: ["serviceAccount"],
  blurb: "The pod's identity in the cluster — and, through annotations, in the cloud account behind it.",
  fields: [
    B("create", "create", { def: true, path: "serviceAccount.create" }),
    S("name", "name", { path: "serviceAccount.name", placeholder: "myapp-sa" }),
    B("automountServiceAccountToken", "automountServiceAccountToken", { def: true }),
    KV("annotations", "annotations"),
    KV("labels", "labels"),
    TX("imagePullSecrets", "imagePullSecrets", { placeholder: "ghcr-pull" }),
  ],
  emit: (v) => {
    const o: Values = { create: v.create !== false };
    put(o, "name", v.name);
    if (v.automountServiceAccountToken === false) o.automountServiceAccountToken = false;
    const a = kvOf(v.annotations);
    if (a) o.annotations = a;
    const lb = kvOf(v.labels);
    if (lb) o.labels = lb;
    const ps = listOf(v.imagePullSecrets).map((name) => ({ name }));
    if (ps.length) o.imagePullSecrets = ps;
    return { serviceAccount: o };
  },
  load: (doc) => {
    const sa = isRecord(doc.serviceAccount) ? doc.serviceAccount : {};
    return {
      create: sa.create !== false,
      name: sa.name ?? "",
      automountServiceAccountToken: sa.automountServiceAccountToken !== false,
      annotations: pairsOf(sa.annotations),
      labels: pairsOf(sa.labels),
      imagePullSecrets: rowsOf(sa.imagePullSecrets).map((r) => String(r.name ?? "")).join("\n"),
    };
  },
  notes: [
    "This chart models exactly one ServiceAccount per release. A CronJob or Job naming a different serviceAccountName needs that account created somewhere else — extraDeploy, or another release. Helm renders the reference without complaint; the pod is what fails.",
    "Turn automountServiceAccountToken off for anything that never talks to the API server — it is a token sitting in every pod otherwise.",
  ],
});

F({
  id: "rbac",
  cat: "ops",
  name: "RBAC",
  keys: ["rbac"],
  cluster: true,
  blurb: "Roles and bindings, keyed by name. Roles land in the release namespace automatically; ClusterRoles are global.",
  fields: [
    RW(
      "roles",
      "Roles",
      [
        { key: "name", label: "Name", placeholder: "myapp-role" },
        { key: "rules", label: "rules", kind: "text", placeholder: '- apiGroups: [""]\n  resources: ["configmaps"]\n  verbs: ["get", "list"]' },
      ],
      { addLabel: "Add Role" }
    ),
    RW(
      "roleBindings",
      "RoleBindings",
      [
        { key: "name", label: "Name", placeholder: "myapp-rolebinding" },
        { key: "roleRef", label: "roleRef", placeholder: "myapp-role" },
        { key: "subjects", label: "subjects — Kind=name[:namespace] per line", kind: "text", placeholder: "ServiceAccount=myapp-sa" },
      ],
      { addLabel: "Add RoleBinding" }
    ),
    RW(
      "clusterRoles",
      "ClusterRoles",
      [
        { key: "name", label: "Name", placeholder: "myapp-cluster-reader" },
        { key: "rules", label: "rules", kind: "text", placeholder: '- apiGroups: [""]\n  resources: ["nodes"]\n  verbs: ["get", "list"]' },
      ],
      { addLabel: "Add ClusterRole" }
    ),
    RW(
      "clusterRoleBindings",
      "ClusterRoleBindings",
      [
        { key: "name", label: "Name", placeholder: "myapp-cluster-rb" },
        { key: "roleRef", label: "roleRef", placeholder: "myapp-cluster-reader" },
        { key: "subjects", label: "subjects", kind: "text", placeholder: "ServiceAccount=myapp-sa:myapp-dev" },
      ],
      { addLabel: "Add ClusterRoleBinding" }
    ),
  ],
  emit: (v) => {
    const subjects = (text: unknown) =>
      listOf(text)
        .map((line) => {
          const i = line.indexOf("=");
          if (i < 0) return null;
          const kind = line.slice(0, i).trim();
          const [name, namespace] = line.slice(i + 1).split(":");
          return clean({ kind, name: (name ?? "").trim(), namespace: namespace?.trim() });
        })
        .filter(Boolean) as Values[];
    const roles = (key: string) => mapOf(v[key], (r) => (nz(r.rules) ? { rules: raw(r.rules) } : null));
    const bindings = (key: string) =>
      mapOf(v[key], (r) => {
        const o: Values = {};
        put(o, "roleRef", r.roleRef);
        const s = subjects(r.subjects);
        if (s.length) o.subjects = s;
        return Object.keys(o).length ? o : null;
      });
    return some({
      rbac: some({
        roles: roles("roles"),
        roleBindings: bindings("roleBindings"),
        clusterRoles: roles("clusterRoles"),
        clusterRoleBindings: bindings("clusterRoleBindings"),
      }),
    });
  },
  notes: [
    "roleRef is just the name of a Role in the same values file — the chart wires up the apiGroup and kind.",
    "ClusterRoles and ClusterRoleBindings are cluster-scoped. Two namespaces deploying the same name are one object, last write wins.",
  ],
});

F({
  id: "servicemonitor",
  cat: "ops",
  name: "ServiceMonitor",
  keys: ["serviceMonitor"],
  blurb: "Tells a Prometheus Operator to scrape this Service. The port is a Service port name, not a number.",
  fields: [
    B("enabled", "enabled", { def: true, path: "serviceMonitor.enabled" }),
    S("namespace", "namespace", { path: "serviceMonitor.namespace", placeholder: "monitoring" }),
    KV("labels", "labels"),
    S("port", "port", { path: "serviceMonitor.port", placeholder: "metrics" }),
    S("path", "path", { path: "serviceMonitor.path", placeholder: "/metrics" }),
    S("interval", "interval", { path: "serviceMonitor.interval", placeholder: "30s" }),
    S("scrapeTimeout", "scrapeTimeout", { path: "serviceMonitor.scrapeTimeout", placeholder: "10s" }),
    SE("scheme", "scheme", ["", "http", "https"], { path: "serviceMonitor.scheme" }),
    YA("tlsConfig", "tlsConfig", { placeholder: "insecureSkipVerify: true" }),
    YA("relabelings", "relabelings", { placeholder: "- sourceLabels: [__meta_kubernetes_pod_name]\n  targetLabel: pod" }),
    YA("metricRelabelings", "metricRelabelings", { placeholder: "- sourceLabels: [__name__]\n  regex: go_.*\n  action: drop" }),
  ],
  emit: (v) => {
    const o: Values = { enabled: v.enabled !== false };
    put(o, "namespace", v.namespace);
    const l = kvOf(v.labels);
    if (l) o.labels = l;
    put(o, "port", v.port);
    put(o, "path", v.path);
    put(o, "interval", v.interval);
    put(o, "scrapeTimeout", v.scrapeTimeout);
    put(o, "scheme", v.scheme);
    if (nz(v.tlsConfig)) o.tlsConfig = raw(v.tlsConfig);
    if (nz(v.relabelings)) o.relabelings = raw(v.relabelings);
    if (nz(v.metricRelabelings)) o.metricRelabelings = raw(v.metricRelabelings);
    return { serviceMonitor: o };
  },
  notes: [
    "The labels must match your Prometheus Operator's serviceMonitorSelector — usually release: prometheus. Without it the object exists and is never picked up, which looks exactly like a broken exporter.",
    "The port has to exist on the Service, so expose the metrics container port through Service too.",
  ],
});

/* ---------- escape hatches ---------- */

F({
  id: "extradeploy",
  cat: "escape",
  name: "extraDeploy",
  keys: ["extraDeploy"],
  blurb: "Any object the chart does not model, rendered through Helm's templating — so {{ .Release.Name }} works.",
  fields: [
    RW(
      "items",
      "Manifests",
      [
        { key: "label", label: "What is it? (comment only)", placeholder: "PrometheusRule" },
        { key: "body", label: "Manifest", kind: "text", placeholder: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-flags" },
      ],
      { addLabel: "Add manifest" }
    ),
  ],
  emit: (v) => {
    const items = rowsOf(v.items)
      .filter((r) => nz(r.body))
      .map((r) => `${String(r.body).replace(/\s+$/, "")}\n`);
    return items.length ? { extraDeploy: items } : null;
  },
  load: (doc) => ({ items: rowsOf(doc.extraDeploy).map((body) => ({ label: "", body })) }),
  notes: [
    "This is the escape hatch, not the front door. Anything here skips the chart's labels, checksums and validation — reach for a modelled key first.",
  ],
});

/* ---------- what studio.html's catalog does not cover ---------- */

F({
  id: "podmeta",
  cat: "core",
  name: "Pod metadata",
  keys: ["podAnnotations", "podLabels"],
  blurb: "Annotations and labels on the pod template only — where a scrape hint, a mesh opt-out or a cost-allocation label goes.",
  fields: [KV("podAnnotations", "podAnnotations"), KV("podLabels", "podLabels")],
  emit: (v) => some({ podAnnotations: kvOf(v.podAnnotations), podLabels: kvOf(v.podLabels) }),
  load: (doc) => ({ podAnnotations: pairsOf(doc.podAnnotations), podLabels: pairsOf(doc.podLabels) }),
  notes: [
    "Changing a pod annotation rolls the pods, which is exactly how checksums forces a restart on a config change.",
  ],
});

F({
  id: "sidecars",
  cat: "container",
  name: "Sidecars & init containers",
  keys: ["sidecars", "initContainers"],
  blurb: "Extra containers beside the main one, keyed by container name. The body is a container spec, passed through as written.",
  fields: [
    RW(
      "sidecars",
      "Sidecars",
      [
        { key: "name", label: "Name", placeholder: "log-shipper" },
        { key: "body", label: "Container spec", kind: "text", placeholder: "image: fluentbit:2.0\nresources:\n  requests:\n    cpu: 50m" },
      ],
      { addLabel: "Add sidecar" }
    ),
    RW(
      "initContainers",
      "Init containers",
      [
        { key: "name", label: "Name", placeholder: "init-db" },
        { key: "body", label: "Container spec", kind: "text", placeholder: 'image: busybox:1.36\ncommand: ["sh", "-c", "until nc -z db 5432; do sleep 2; done"]' },
      ],
      { addLabel: "Add init container" }
    ),
  ],
  emit: (v) =>
    some({
      sidecars: mapOf(v.sidecars, (r) => (nz(r.body) ? (raw(r.body) as unknown as Values) : null)),
      initContainers: mapOf(v.initContainers, (r) => (nz(r.body) ? (raw(r.body) as unknown as Values) : null)),
    }),
  notes: [
    "restartPolicy: Always on an init container is what makes it a native sidecar (Kubernetes 1.29+) — it starts before the main container and keeps running.",
  ],
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
