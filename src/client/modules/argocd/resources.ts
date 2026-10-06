import { enabled, obj, present } from "./values";
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

/**
 * Not everything on a card is the same *kind* of thing, and showing them alike
 * was actively misleading — a `volumeClaimTemplates` entry read exactly like a
 * standalone PersistentVolumeClaim, when one is a stanza inside the StatefulSet
 * and the other is an object with its own lifetime.
 *
 * - `workload` — the object carrying this release's pods. There is at most one.
 * - `pod`      — part of that object's template. It has no separate existence:
 *                delete the workload and it goes with it.
 * - `object`   — a namespaced object of its own, created beside the workload.
 * - `cluster`  — cluster-scoped, so exactly one release in the cluster may own
 *                it. `checks.ts` already warns when a tree fans one of these
 *                out over several namespaces.
 */
export type Scope = "workload" | "pod" | "object" | "cluster";

export type Resource = {
  /** The Kubernetes kind, as it is written in a manifest. */
  kind: string;
  /** The objects' own names, where the document keys them — shown on hover. */
  names?: string[];
  scope: Scope;
  /**
   * The catalog feature that produced it, so pressing the chip can take you to
   * the fields that set it. Absent where nothing in the catalog owns it —
   * `extraDeploy` manifests and anything that arrived through extra values.
   */
  feature?: string;
};

/** What each scope means, said on the chip rather than in a legend. */
export const SCOPE_NOTE: Record<Scope, string> = {
  workload: "The object that carries this release's pods.",
  pod: "Part of the workload's pod template — not an object of its own.",
  object: "An object of its own, in this release's namespace.",
  cluster: "Cluster-scoped — only one release in the cluster may own it.",
};

const RANK: Record<Scope, number> = { workload: 0, pod: 1, object: 2, cluster: 3 };

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
  const add = (kind: string, scope: Scope, feature?: string, names?: string[]) => {
    const found = out.find((r) => r.kind === kind);
    if (!found) out.push({ kind, scope, ...(feature ? { feature } : {}), ...(names?.length ? { names } : {}) });
    else if (names?.length) found.names = [...(found.names ?? []), ...names];
  };
  /** A map of objects keyed by name: `configMaps`, `cronjobs`, `pvc`, … */
  const fromMap = (kind: string, scope: Scope, feature: string, v: unknown) => {
    const keys = Object.keys(obj(v));
    if (keys.length) add(kind, scope, feature, keys);
  };

  const workload = String(obj(doc.workload).type ?? "deployment");
  // `none` is a release that owns no pods — a config-only or RBAC-only one.
  if (WORKLOAD_KINDS[workload]) add(WORKLOAD_KINDS[workload], "workload", "workload");

  // ---- inside the pod template ------------------------------------------
  fromMap("Sidecar", "pod", "sidecars", doc.sidecars);
  fromMap("Init container", "pod", "sidecars", doc.initContainers);
  fromMap("Volume", "pod", "volumes", doc.volumes);
  // A PVC per replica, minted by the StatefulSet and named `<template>-<pod>`.
  // It really is a PersistentVolumeClaim in the end, which is exactly why it
  // needs saying that this one is not a standalone object.
  fromMap("PVC per replica", "pod", "vct", doc.volumeClaimTemplates);

  // ---- objects of their own, in this namespace --------------------------
  if (enabled(doc.service)) add("Service", "object", "service");
  fromMap("Service", "object", "services", doc.services);
  if (enabled(doc.ingress)) add("Ingress", "object", "ingress");
  if (enabled(doc.route)) add("Route", "object", "route");
  fromMap("Route", "object", "routes", doc.routes);
  fromMap("NetworkPolicy", "object", "netpol", doc.networkPolicies);

  fromMap("ConfigMap", "object", "configmaps", doc.configMaps);
  fromMap("Secret", "object", "secrets", doc.secrets);
  fromMap("ExternalSecret", "object", "externalsecrets", doc.externalSecrets);
  fromMap("SecretStore", "object", "secretstores", doc.secretStores);

  fromMap("PersistentVolumeClaim", "object", "pvc", doc.pvc);

  if (enabled(doc.hpa)) add("HorizontalPodAutoscaler", "object", "hpa");
  if (enabled(doc.vpa)) add("VerticalPodAutoscaler", "object", "vpa");
  if (enabled(doc.pdb)) add("PodDisruptionBudget", "object", "pdb");

  fromMap("CronJob", "object", "cronjobs", doc.cronjobs);
  fromMap("Job", "object", "jobs", doc.jobs);

  // The chart models exactly one ServiceAccount, and `create: false` means it
  // is referencing one somebody else made.
  if (present(doc.serviceAccount) && obj(doc.serviceAccount).create !== false) add("ServiceAccount", "object", "serviceaccount");

  const rbac = obj(doc.rbac);
  fromMap("Role", "object", "rbac", rbac.roles);
  fromMap("RoleBinding", "object", "rbac", rbac.roleBindings);

  if (enabled(doc.serviceMonitor)) add("ServiceMonitor", "object", "servicemonitor");

  // ---- cluster-scoped: one owner, cluster-wide --------------------------
  fromMap("ClusterSecretStore", "cluster", "secretstores", doc.clusterSecretStores);
  fromMap("PersistentVolume", "cluster", "pv", doc.persistentVolumes);
  fromMap("StorageClass", "cluster", "storageclass", doc.storageClasses);
  fromMap("ClusterRole", "cluster", "rbac", rbac.clusterRoles);
  fromMap("ClusterRoleBinding", "cluster", "rbac", rbac.clusterRoleBindings);
  fromMap("SecurityContextConstraints", "cluster", "scc", doc.scc);

  // An escape hatch says what it is in its own text, or it says nothing. Its
  // scope is unknowable without rendering the template, so it is left as an
  // ordinary object rather than guessed at.
  (Array.isArray(doc.extraDeploy) ? doc.extraDeploy : []).forEach((entry) => {
    const kinds = kindsOf(entry);
    if (kinds.length) kinds.forEach((k) => add(k, "object", "extradeploy"));
    else add("extraDeploy", "object", "extradeploy");
  });

  // Stable, so declaration order survives inside each group.
  return out.sort((a, b) => RANK[a.scope] - RANK[b.scope]);
}

/** The kinds in `over` that `base` does not already create — what an override adds. */
export function addedKinds(base: Resource[], over: Resource[]): string[] {
  const had = new Set(base.map((r) => r.kind));
  return over.map((r) => r.kind).filter((k) => !had.has(k));
}
