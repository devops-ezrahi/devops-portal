import { GitCompare } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { BranchDiffView } from "./BranchDiffView";

export const branchDiffModule: PortalModule = {
  id: "branchdiff",
  userNav: { label: "Branch Diff", Icon: GitCompare },
  adminNav: { label: "Branch Diff", Icon: GitCompare },
  View: BranchDiffView,
};
