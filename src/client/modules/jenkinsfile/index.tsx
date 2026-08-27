import { FileCode2 } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { JenkinsfileView } from "./JenkinsfileView";

export const jenkinsfileModule: PortalModule = {
  id: "jenkinsfile",
  userNav: { label: "Jenkinsfile", Icon: FileCode2 },
  adminNav: { label: "Jenkinsfile", Icon: FileCode2 },
  View: JenkinsfileView,
};
