import { defaultValues } from "./catalog";
import type { TreeDefaults, TreeInput } from "./api";
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
export const newNamespace = (name = ""): ArgocdNamespace => ({ name, releases: [] });

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
    defaults: { features: {} },
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
    defaults: tree.defaults,
  };
}

/** The state a feature starts in when it is switched on. */
export const initialFeature = (id: string) => ({ on: true, v: defaultValues(id) });

/** A tree nobody has typed into — autosave must not litter the list with these. */
export const isEmptyTree = (tree: DraftTree) =>
  !tree.releases.length && !tree.namespaces.length && !Object.keys(tree.defaults?.features ?? {}).length;
