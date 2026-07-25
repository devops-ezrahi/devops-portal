import { Sparkles } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { WhiteningView } from "./WhiteningView";

export const whiteningModule: PortalModule = {
  id: "whitening",
  userNav: { label: "Whitening", Icon: Sparkles },
  adminNav: { label: "Whitening", Icon: Sparkles },
  View: WhiteningView,
};
