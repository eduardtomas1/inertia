import { createSurfaceLoader } from "../../utils/surfaceLoader";

export const loadThreadActions = createSurfaceLoader(async () => ({
  default: (await import("../ConversationActionsMenu")).ConversationActionsMenu,
}));
