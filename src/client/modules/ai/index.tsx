import { Sparkles } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { AiView } from "./AiView";

export const aiModule: PortalModule = {
  id: "ai",
  userNav: { label: "AI", Icon: Sparkles },
  adminNav: { label: "AI", Icon: Sparkles },
  View: AiView,
};
