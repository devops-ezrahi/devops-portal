import { SprayCan } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { WhiteningView } from "./WhiteningView";

export const whiteningModule: PortalModule = {
  id: "whitening",
  userNav: { label: "Whitening", Icon: SprayCan },
  adminNav: { label: "Whitening", Icon: SprayCan },
  View: WhiteningView,
};
