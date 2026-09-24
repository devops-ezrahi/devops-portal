import { defaultValues, mapRows, parsePorts } from "./catalog";
import type { FeatureState } from "./catalog";
import type { TreeDefaults, TreeInput } from "./api";
import { buildValues } from "./build";
import { importValues } from "./import";
import type { TreeImport } from "./importTree";
import { deepMerge } from "./values";
import { toYaml } from "./yaml";
import type { ArgocdNamespace, ArgocdRelease, ArgocdTree } from "../../../server/types";

/**
 * The tree as the editor holds it. Same shape the server stores, so there is no
 * draft type to keep in step — a tree has no legacy shape to migrate and no
 * client-only field.
 */
export type DraftTree = ArgocdTree;

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

export const newRelease = (name = "", features: ArgocdRelease["features"] = {}): ArgocdRelease => ({
  id: uid("r"),
  name,
  features,
});

/**
 * The namespace-shared release, as `convert_to_universal_chart.py` writes it:
 * a release named `shared`, `workload.type: none`, no Service. It owns the
 * objects several microservices in a namespace use — ConfigMaps, Secrets,
 * PVCs, NetworkPolicies, Roles — so they are declared once instead of by every
 * consumer, which is what stops two Helm releases claiming the same name.
 *
 * It is an ordinary release in every other respect (`base/shared.yaml`,
 * `<ns>/values/shared.yaml`), which is the whole reason it needs nothing else
 * here: the fan-out and the layering already cover it.
 */
export const SHARED_RELEASE_NAME = "shared";
export const newSharedRelease = (): ArgocdRelease =>
  newRelease(SHARED_RELEASE_NAME, {
    workload: { on: true, v: { type: "none" } },
    service: { on: true, v: { enabled: false } },
  });
export const newNamespace = (name = ""): ArgocdNamespace => ({ name, releases: [], defaults: { features: {} } });

/**
 * A tree saved when Defaults were tree-wide, moved onto its namespaces.
 *
 * Each namespace takes a copy, its own settings winning where both exist. The
 * returned keys are what now deploys differently: the chart layers a
 * namespace's defaults *over* base, so a copied default a base file also sets
 * used to lose to it and now wins — the caller says so rather than letting it
 * change silently.
 */
export function migrateTreeDefaults(tree: ArgocdTree): { tree: ArgocdTree; overridesBase: string[] } {
  const legacy = tree.defaults;
  if (!legacy || (!Object.keys(legacy.features ?? {}).length && !legacy.extraValues?.trim()))
    return { tree: { ...tree, defaults: undefined }, overridesBase: [] };
  const overridesBase = [
    ...new Set(
      tree.releases.flatMap((r) => Object.keys(legacy.features).filter((id) => legacy.features[id]?.on && r.features[id]?.on))
    ),
  ];
  const namespaces = tree.namespaces.map((ns) => ({
    ...ns,
    defaults: {
      features: { ...legacy.features, ...(ns.defaults?.features ?? {}) },
      extraValues: ns.defaults?.extraValues?.trim() ? ns.defaults.extraValues : legacy.extraValues,
    },
  }));
  return { tree: { ...tree, namespaces, defaults: undefined }, overridesBase };
}

/**
 * A tree saved when the Service's ports were `name=port:targetPort` text, with
 * them turned into the rows the form now edits. Emit still reads the text, so
 * nothing deploys differently either way — this is what keeps them on screen.
 */
export function migrateServicePorts(tree: ArgocdTree): ArgocdTree {
  const fix = (features: Record<string, FeatureState> = {}) => {
    const service = features.service;
    if (typeof service?.v.ports !== "string") return features;
    return { ...features, service: { ...service, v: { ...service.v, ports: mapRows(parsePorts(service.v.ports)) } } };
  };
  return {
    ...tree,
    releases: tree.releases.map((r) => ({ ...r, features: fix(r.features) })),
    namespaces: tree.namespaces.map((ns) => ({
      ...ns,
      releases: ns.releases.map((e) => ({ ...e, features: fix(e.features) })),
      defaults: ns.defaults && { ...ns.defaults, features: fix(ns.defaults.features) },
    })),
  };
}

export function newTree(defaults?: TreeDefaults): DraftTree {
  return {
    id: "",
    name: "",
    chart: {
      repoUrl: defaults?.chartRepoUrl ?? "",
      path: defaults?.chartPath ?? ".",
      appsetPath: defaults?.appsetChartPath ?? "ms-applicationSet",
      revision: defaults?.chartRevision ?? "main",
    },
    values: { repoUrl: defaults?.valuesRepoUrl ?? "", revision: defaults?.valuesRevision ?? "main", path: "" },
    rootAppName: "platform-root",
    releases: [],
    namespaces: [],
    createdBy: "",
    createdByName: "",
    createdAt: "",
    updatedAt: "",
  };
}

/** What goes on the wire — the server owns everything else. */
export function toInput(tree: DraftTree): TreeInput {
  return {
    name: tree.name,
    chart: tree.chart,
    values: tree.values,
    rootAppName: tree.rootAppName,
    releases: tree.releases,
    namespaces: tree.namespaces,
  };
}

/** The state a feature starts in when it is switched on. */
export const initialFeature = (id: string) => ({ on: true, v: defaultValues(id) });

/** A tree nobody has typed into — autosave must not litter the list with these. */
export const isEmptyTree = (tree: DraftTree) => !tree.releases.length && !tree.namespaces.length;

/**
 * A converted tree folded into the one on screen, so converting adds
 * microservices to a tree that is already connected and commits with it.
 *
 * - A microservice with the same name is replaced — converting again is how an
 *   updated manifest comes in — and keeps its id, so its tabs survive.
 * - Into a namespace the tree already has, the converter's `<ns>/defaults.yaml`
 *   is folded into each converted microservice's own entry: that namespace
 *   keeps the defaults it has, and the converted values still land exactly as
 *   the converter layered them.
 * - A new namespace comes across whole.
 */
export function mergeConverted(tree: DraftTree, imported: TreeImport): { tree: DraftTree; replaced: string[] } {
  const replaced: string[] = [];
  const idOf = new Map<string, string>();
  const releases = [...tree.releases];
  for (const r of imported.releases) {
    const at = releases.findIndex((x) => x.name === r.name);
    if (at < 0) {
      releases.push(r);
      idOf.set(r.id, r.id);
    } else {
      replaced.push(r.name);
      releases[at] = { ...r, id: releases[at].id };
      idOf.set(r.id, releases[at].id);
    }
  }

  const namespaces = [...tree.namespaces];
  for (const ns of imported.namespaces) {
    const entries = ns.releases.map((e) => ({ ...e, release: idOf.get(e.release) ?? e.release }));
    const absent = ns.absent?.map((id) => idOf.get(id) ?? id);
    const at = namespaces.findIndex((x) => x.name === ns.name);
    if (at < 0) {
      namespaces.push({ ...ns, releases: entries, ...(absent ? { absent } : {}) });
      continue;
    }
    const defaults = buildValues(ns.defaults?.features ?? {}, ns.defaults?.extraValues);
    const folded = entries.map((e) => {
      const { features, extraValues } = importValues(toYaml(deepMerge(defaults, buildValues(e.features, e.extraValues))));
      return { ...e, features, extraValues };
    });
    const target = namespaces[at];
    namespaces[at] = {
      ...target,
      releases: [...target.releases.filter((e) => !folded.some((f) => f.release === e.release)), ...folded],
    };
  }
  return { tree: { ...tree, releases, namespaces }, replaced };
}
