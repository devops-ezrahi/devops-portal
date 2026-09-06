import { request } from "../../api";
import type { ArgocdTree } from "../../../server/types";

/**
 * What the server accepts. Its own id, owner, timestamps — and `name`, which it
 * mints from the author — are its business, not the builder's.
 */
export type TreeInput = Pick<ArgocdTree, "name" | "chart" | "values" | "rootAppName" | "releases" | "namespaces">;

/** Where the chart and the values repo live — configured, and only a starting point. */
export type TreeDefaults = {
  chartRepoUrl: string;
  chartPath: string;
  chartRevision: string;
  valuesRepoUrl: string;
  valuesRevision: string;
};

export function listTrees() {
  // `defaults` rides along rather than needing its own endpoint — the builder
  // needs it before it can offer a new tree.
  return request<{ trees: ArgocdTree[]; defaults: TreeDefaults }>("/api/argocd/trees");
}

export function createTree(input: TreeInput) {
  return request<{ tree: ArgocdTree }>("/api/argocd/trees", { method: "POST", body: JSON.stringify(input) });
}

export function updateTree(id: string, input: TreeInput) {
  return request<{ tree: ArgocdTree }>(`/api/argocd/trees/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deleteTree(id: string) {
  return request<{ ok: true }>(`/api/argocd/trees/${id}`, { method: "DELETE" });
}
