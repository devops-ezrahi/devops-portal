import { Layers } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ArgocdView } from "./ArgocdView";

export const argocdModule: PortalModule = {
  id: "argocd",
  userNav: { label: "ArgoCD", Icon: Layers },
  adminNav: { label: "ArgoCD", Icon: Layers },
  View: ArgocdView,
};
