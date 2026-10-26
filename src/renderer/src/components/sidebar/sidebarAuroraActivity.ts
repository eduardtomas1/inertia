import type { SidebarThreadView } from "../../utils/sidebarModel";
import type { SidebarAuroraActivity } from "./SidebarAurora";

export function sidebarAuroraActivity(threads: Iterable<SidebarThreadView>): SidebarAuroraActivity {
  let working = false;
  for (const { conversation, hidden, needsAttention, settled, status } of threads) {
    if (conversation.archivedAt !== null || hidden) continue;
    if (needsAttention && !settled && (status === "approval" || status === "input" || status === "failed")) {
      return "attention";
    }
    if (status === "working") working = true;
  }
  return working ? "working" : "idle";
}
