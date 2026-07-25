import { MessageSquare } from "lucide-react";
import type { PortalModule } from "../../moduleTypes";
import { ChatView } from "./ChatView";

export const ragflowModule: PortalModule = {
  id: "ragflow",
  userNav: { label: "Chat", Icon: MessageSquare },
  adminNav: { label: "Chat", Icon: MessageSquare },
  View: ChatView,
};
