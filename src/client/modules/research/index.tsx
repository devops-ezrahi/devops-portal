import { Sparkles } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ResearchView } from "./ResearchView";

export const researchModule: PortalModule = {
  id: "research",
  userNav: { label: "AI", Icon: Sparkles },
  adminNav: { label: "AI", Icon: Sparkles },
  View: ResearchView,
};
