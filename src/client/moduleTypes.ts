import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { PortalUser } from "../server/types";

export type ModuleViewProps = {
  user: PortalUser;
  isAdmin: boolean;
  refreshKey: number;
  onError: (message: string) => void;
};

export type PortalModule = {
  id: string;
  userNav: { label: string; Icon: LucideIcon };
  adminNav: { label: string; Icon: LucideIcon };
  View: ComponentType<ModuleViewProps>;
};
