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
  appsetChartPath: string;
  chartRevision: string;
  valuesRepoUrl: string;
  valuesRevision: string;
};

/** One file of a values repo, in both directions. */
export type RepoFile = { path: string; text: string };

export function listTrees() {
  // `defaults` rides along rather than needing its own endpoint — the builder
  // needs it before it can offer a new tree.
  return request<{ trees: ArgocdTree[]; defaults: TreeDefaults; gitEnabled: boolean }>("/api/argocd/trees");
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

/** Read an existing tree out of a values repo. Reversing it is `importTree`'s job. */
export function pullValues(repoUrl: string, revision: string, path: string) {
  // `repoUrl` comes back because the server may have rewritten it — an SSH URL
  // is normalised to its https form before anything is cloned.
  return request<{ files: RepoFile[]; repoUrl: string }>("/api/argocd/pull", {
    method: "POST",
    body: JSON.stringify({ repoUrl, revision, path }),
  });
}

/**
 * Commit the generated files onto this tree's branch and open a PR. The
 * destination is the *stored* tree's, so a push always follows a save.
 */
export function pushTree(id: string, files: RepoFile[], branch?: string, message?: string) {
  return request<{ branch: string; changed: boolean; prUrl: string; note?: string }>(
    `/api/argocd/trees/${id}/push`,
    { method: "POST", body: JSON.stringify({ files, branch, message }) }
  );
}
