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

export const newRelease = (name = ""): ArgocdRelease => ({ id: uid("r"), name, features: {} });
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
