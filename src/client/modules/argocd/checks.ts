import { enabled, list, obj, present } from "./values";
import type { Values } from "./values";

/**
 * The cross-checks the cookbook documents, ported from `ui/studio.html`'s own
 * `checks()`. They run over the *merged* document rather than over catalog
 * state, so a value that arrived through `extraValues` or an import is checked
 * exactly like one typed into a field.
 *
 * `bad` is something the chart or the cluster rejects; `warn` renders fine and
 * then misbehaves at runtime, which is the harder half to find.
 */
export type Problem = {
  level: "bad" | "warn";
  text: string;
  /**
   * The catalog feature the problem is about, so pressing it opens those
   * fields — the same `data-feature` jump a release card's chip already makes.
   * A problem that is about the tree rather than about one field has none.
   */
  feature?: string;
};

/** Whether the HPA scales on a CPU utilisation target — the one that needs a request. */
function hasCpuTarget(hpa: Values): boolean {
  return list(hpa.metrics).some((m) => obj(m.resource).name === "cpu" && obj(obj(m.resource).target).type === "Utilization");
}

export function checkValues(doc: Values): Problem[] {
  const out: Problem[] = [];
  const bad = (text: string, feature?: string) => out.push({ level: "bad", text, ...(feature ? { feature } : {}) });
  const warn = (text: string, feature?: string) => out.push({ level: "warn", text, ...(feature ? { feature } : {}) });

  const workload = String(obj(doc.workload).type ?? "deployment");
  const service = obj(doc.service);
  const hpa = obj(doc.hpa);
  const servicePorts = Object.keys(obj(service.ports));

  if (workload === "none") {
    (["hpa", "vpa", "pdb"] as const).forEach((key) => {
      if (enabled(doc[key])) bad(`${key}.enabled with workload.type: none fails the chart's own validation — there are no pods to scale, resize or protect.`, key);
    });
    if (enabled(service)) warn("A Service with workload.type: none selects nothing. Set service.enabled: false unless you supply your own selector.", "service");
  }

  if (enabled(doc.ingress) && enabled(doc.route))
    bad("ingress.enabled and route.enabled cannot both be true — the chart fails the render. Pick the Ingress or the Route.", "ingress");

  if (enabled(hpa) && workload === "daemonset")
    bad("HPA is not supported for a DaemonSet — pod count is one per node by definition, and the chart fails the render.", "hpa");

  if (enabled(doc.ingress) && !servicePorts.length) {
    const missing = list(obj(doc.ingress).hosts).some((h) => list(h.paths).some((p) => !p.portName));
    if (missing)
      bad("An Ingress path with no portName and no Service ports leaves the backend port blank — the chart fails the render.", "ingress");
  }

  if (enabled(doc.route) && !obj(doc.route).targetPort && !servicePorts.length)
    bad("route.targetPort is unset and the Service has no ports — the Route target port would be blank.", "route");

  if (enabled(hpa) && doc.replicaCount !== undefined)
    warn("Both replicaCount and HPA are set. Every sync writes the replica count back and the HPA scales it away again — drop replicaCount.", "hpa");

  if (enabled(hpa) && hasCpuTarget(hpa) && !obj(obj(doc.resources).requests).cpu)
    warn("A CPU-target HPA needs resources.requests.cpu — utilisation is a percentage of the request.", "resources");

  if (enabled(hpa) && hasCpuTarget(hpa) && enabled(doc.vpa))
    bad("A CPU-target HPA and VPA on the same workload fight each other. Use HPA for pod count, VPA for one pod's size — not both on CPU.", "vpa");

  if (present(doc.volumeClaimTemplates) && workload !== "statefulset")
    bad(`volumeClaimTemplates is StatefulSet-only. With workload.type: ${workload} it renders nothing.`, "vct");

  if (present(doc.volumeClaimTemplates) && !present(doc.persistentVolumeClaimRetentionPolicy))
    warn("No persistentVolumeClaimRetentionPolicy. Kubernetes defaults to Delete, so deleting the StatefulSet deletes the data.", "vct");

  if (workload === "statefulset" && enabled(service) && service.clusterIP !== "None" && !present(doc.services))
    warn("A StatefulSet with no headless Service has no per-pod DNS. Set service.clusterIP: None, or add a headless entry under Extra Services.", "service");

  if (present(doc.pdb) && doc.replicaCount !== undefined && String(obj(doc.pdb).minAvailable) === String(doc.replicaCount))
    bad("pdb.minAvailable equals replicaCount — no pod can ever be evicted and node drains hang forever.", "pdb");

  const replicas = Number(doc.replicaCount ?? 1);
  // No accessModes at all is ReadWriteOnce — that is the Kubernetes default.
  const sharedRwo = Object.values(obj(doc.pvc)).some((p) => {
    const modes = list(obj(p).accessModes).length ? (obj(p).accessModes as unknown[]).map(String) : ["ReadWriteOnce"];
    return modes.includes("ReadWriteOnce");
  });
  if (sharedRwo && replicas > 1 && workload === "deployment")
    bad(`A ReadWriteOnce PVC shared by ${replicas} replicas — the second pod stays Pending. Use ReadWriteMany, or a StatefulSet with volumeClaimTemplates.`, "pvc");

  if (obj(doc.securityContext).readOnlyRootFilesystem) {
    const tmp = Object.values(obj(doc.volumeMounts)).some((m) => String(obj(m).mountPath ?? "").startsWith("/tmp"));
    if (!tmp) warn("readOnlyRootFilesystem: true with nothing mounted at /tmp. Most runtimes fail on their first temp file — add an emptyDir.", "mounts");
  }

  if (doc.hostNetwork === true && doc.dnsPolicy !== "ClusterFirstWithHostNet")
    bad("hostNetwork: true without dnsPolicy: ClusterFirstWithHostNet — the pod uses the node's resolver and no Service name resolves.", "hostns");

  const monitor = obj(doc.serviceMonitor);
  if (enabled(monitor) && !present(monitor.labels))
    warn("ServiceMonitor with no labels. Prometheus Operator selects on them — usually release: prometheus — so an unlabelled one is silently never scraped.", "servicemonitor");
  if (enabled(monitor) && monitor.port && servicePorts.length && !servicePorts.includes(String(monitor.port)))
    warn(`ServiceMonitor scrapes port ${monitor.port}, which is not one of the Service ports (${servicePorts.join(", ")}).`, "servicemonitor");

  const defined = new Set([...Object.keys(obj(doc.volumes)), ...Object.keys(obj(doc.volumeClaimTemplates))]);
  Object.keys(obj(doc.volumeMounts)).forEach((name) => {
    if (!defined.has(name)) bad(`Mount ${name} has no matching volume or volumeClaimTemplate. The pod will not start.`, "mounts");
  });

  // The chart models exactly one ServiceAccount, so a batch entry naming
  // another one renders happily and then fails to schedule.
  const wanted = [...Object.values(obj(doc.cronjobs)), ...Object.values(obj(doc.jobs))]
    .map((entry) => obj(obj(entry).jobTemplate).serviceAccountName ?? obj(entry).serviceAccountName)
    .filter(Boolean)
    .map(String);
  if (wanted.length) {
    const sa = obj(doc.serviceAccount);
    const made = sa.create !== false && sa.name ? [String(sa.name)] : [];
    const dangling = [...new Set(wanted.filter((n) => !made.includes(n)))];
    if (dangling.length)
      warn(`${dangling.join(", ")} is named as a serviceAccountName but nothing in this release creates it — it has to come from extraDeploy or another release.`, "serviceaccount");
  }

  // The findings `convert_to_universal_chart.py` reports since the fork merge,
  // so a release typed here is warned about what a converted one would be.
  const services: [string, Values, string][] = [
    ["service", service, "service"],
    ...Object.entries(obj(doc.services)).map(([name, s]): [string, Values, string] => [name, obj(s), "services"]),
  ];
  services.forEach(([name, s, feature]) => {
    if (String(s.type ?? "ClusterIP") === "ClusterIP" && Object.values(obj(s.ports)).some((p) => obj(p).nodePort !== undefined))
      bad(`Service ${name} is ClusterIP but sets a nodePort — the API server rejects it. Use type: NodePort, or drop the nodePort.`, feature);
  });

  const unbounded = Object.entries(obj(doc.volumes))
    .filter(([, v]) => "emptyDir" in obj(v) && !obj(obj(v).emptyDir).sizeLimit)
    .map(([name]) => name);
  if (unbounded.length)
    warn(`emptyDir ${unbounded.join(", ")} has no sizeLimit — one runaway writer fills the node's disk and every pod on it is evicted.`, "volumes");

  const pvs = Object.keys(obj(doc.persistentVolumes));
  Object.entries(obj(doc.pvc)).forEach(([name, p]) => {
    const volumeName = obj(p).volumeName;
    if (volumeName && !pvs.includes(String(volumeName)))
      warn(`PVC ${name} binds volumeName ${volumeName}, which this release does not create. Unless that PersistentVolume already exists, the claim stays Pending.`, "pvc");
  });

  Object.entries(obj(doc.configMaps)).forEach(([name, cm]) => {
    Object.values(obj(obj(cm).data)).forEach((body) => {
      const text = String(body ?? "");
      if (/^\s*dir\s+"?\/(var\/)?tmp\b/m.test(text))
        warn(`ConfigMap ${name} sets Redis dir to /tmp — the dump is written to scratch space and lost on restart.`, "configmaps");
      for (const m of text.matchAll(/^\s*sentinel\s+down-after-milliseconds\s+\S+\s+(\d+)/gm))
        if (Number(m[1]) < 5000)
          warn(`ConfigMap ${name} sets sentinel down-after-milliseconds to ${m[1]} — under 5000 a GC pause or a slow network triggers a failover.`, "configmaps");
    });
  });

  if (!obj(doc.image).repository && workload !== "none")
    bad("No image.repository. The chart's schema requires it for any workload that runs pods.", "image");

  return out;
}
