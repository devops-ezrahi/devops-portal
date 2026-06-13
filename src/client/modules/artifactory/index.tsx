import { Package } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ArtifactoryView } from "./ArtifactoryView";

export const artifactoryModule: PortalModule = {
  id: "artifactory",
  userNav: { label: "Artifactory", Icon: Package },
  adminNav: { label: "Artifactory", Icon: Package },
  View: ArtifactoryView,
};
