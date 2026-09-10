import { enabled, list, obj, present } from "./values";
import type { Values } from "./values";

/**
 * What a release actually puts in the cluster.
 *
 * This reads the *built* document — `buildValues(features, extraValues)` — and
 * not the catalog state behind it, for the same reason `checks.ts` does: a
 * feature that is switched on can still emit nothing (every field blank), and a
 * value that arrived through an import or the extra-values box has no feature
 * state at all. The document is the only thing that says what will exist.
 *
 * It is a summary for the release card, not a render: `extraDeploy` is read for
 * its `kind:` line rather than templated, and anything the chart creates as a
 * side effect of a workload (the pods themselves, an ESO-managed Secret) is not
 * counted twice.
 */
export type Resource = {
  /** The Kubernetes kind, as it is written in a manifest. */
  kind: string;
  /** The objects' own names, where the document keys them — shown on hover. */
  names?: string[];
  /**
   * The object carrying this release's pods, if it has any. Flagged rather than
   * inferred from position: `workload.type: none` is a real release — a
   * config-only or RBAC-only one — and its first object is an ordinary
   * ConfigMap, not something to present as what the release *is*.
   */
  workload?: true;
};

const WORKLOAD_KINDS: Record<string, string> = {
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
};

/** A `kind:` line in a hand-written manifest. Multi-doc entries name each one. */
function kindsOf(manifest: unknown): string[] {
  return [...String(manifest ?? "").matchAll(/^kind:[ \t]*(\S+)/gm)].map((m) => m[1]);
}

export function resourcesOf(doc: Values): Resource[] {
  const out: Resource[] = [];
  /** One entry per kind, with the names folded together — `ConfigMap` twice reads as a mistake. */
  const add = (kind: string, names?: string[]) => {
    const found = out.find((r) => r.kind === kind);
    if (!found) out.push(names?.length ? { kind, names } : { kind });
    else if (names?.length) found.names = [...(found.names ?? []), ...names];
  };
  /** A map of objects keyed by name: `configMaps`, `cronjobs`, `pvc`, … */
  const fromMap = (kind: string, v: unknown) => {
    const keys = Object.keys(obj(v));
    if (keys.length) add(kind, keys);
  };

  const workload = String(obj(doc.workload).type ?? "deployment");
  // `none` is a release that owns no pods — a config-only or RBAC-only one.
  if (WORKLOAD_KINDS[workload]) out.push({ kind: WORKLOAD_KINDS[workload], workload: true });

  if (enabled(doc.service)) add("Service");
  fromMap("Service", doc.services);
  if (enabled(doc.ingress)) add("Ingress");
  if (enabled(doc.route)) add("Route");
  fromMap("Route", doc.routes);
  fromMap("NetworkPolicy", doc.networkPolicies);

  fromMap("ConfigMap", doc.configMaps);
  fromMap("Secret", doc.secrets);
  fromMap("ExternalSecret", doc.externalSecrets);
  fromMap("SecretStore", doc.secretStores);
  fromMap("ClusterSecretStore", doc.clusterSecretStores);

  fromMap("PersistentVolumeClaim", doc.pvc);
  // Not standalone objects: the StatefulSet mints one set per replica.
  fromMap("PVC per replica", doc.volumeClaimTemplates);
  fromMap("PersistentVolume", doc.persistentVolumes);
  fromMap("StorageClass", doc.storageClasses);

  if (enabled(doc.hpa)) add("HorizontalPodAutoscaler");
  if (enabled(doc.vpa)) add("VerticalPodAutoscaler");
  if (enabled(doc.pdb)) add("PodDisruptionBudget");

  fromMap("CronJob", doc.cronjobs);
  fromMap("Job", doc.jobs);

  // The chart models exactly one ServiceAccount, and `create: false` means it
  // is referencing one somebody else made.
  if (present(doc.serviceAccount) && obj(doc.serviceAccount).create !== false) add("ServiceAccount");

  const rbac = obj(doc.rbac);
  ([
    ["roles", "Role"],
    ["roleBindings", "RoleBinding"],
    ["clusterRoles", "ClusterRole"],
    ["clusterRoleBindings", "ClusterRoleBinding"],
  ] as const).forEach(([key, kind]) => fromMap(kind, rbac[key]));

  if (enabled(doc.serviceMonitor)) add("ServiceMonitor");
  fromMap("SecurityContextConstraints", doc.scc);

  // An escape hatch says what it is in its own text, or it says nothing.
  (Array.isArray(doc.extraDeploy) ? doc.extraDeploy : []).forEach((entry) => {
    const kinds = kindsOf(entry);
    if (kinds.length) kinds.forEach((k) => add(k));
    else add("extraDeploy");
  });

  return out;
}

/** The kinds in `over` that `base` does not already create — what an override adds. */
export function addedKinds(base: Resource[], over: Resource[]): string[] {
  const had = new Set(base.map((r) => r.kind));
  return over.map((r) => r.kind).filter((k) => !had.has(k));
}
