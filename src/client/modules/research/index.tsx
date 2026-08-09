import { Search } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ResearchView } from "./ResearchView";

export const researchModule: PortalModule = {
  id: "research",
  userNav: { label: "Research", Icon: Search },
  adminNav: { label: "Research", Icon: Search },
  View: ResearchView,
};
