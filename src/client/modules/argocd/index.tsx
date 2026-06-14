import { GitBranch } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ArgoCdView } from "./ArgoCdView";

export const argoCdModule: PortalModule = {
  id: "argocd",
  userNav: { label: "Argo CD", Icon: GitBranch },
  adminNav: { label: "Argo CD", Icon: GitBranch },
  View: ArgoCdView,
};
