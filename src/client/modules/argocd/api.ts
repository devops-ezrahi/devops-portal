import { request } from "../../api";
import type { ArgoCdDashboard } from "../../../server/types";

export function listArgoCdProjects() {
  return request<ArgoCdDashboard>("/api/argocd/projects");
}
