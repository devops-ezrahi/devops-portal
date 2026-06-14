import { request } from "../../api";
import type { BranchDiffDashboard } from "../../../server/types";

export function getGitRepoDiff() {
  return request<BranchDiffDashboard>("/api/git-repo-diff");
}
