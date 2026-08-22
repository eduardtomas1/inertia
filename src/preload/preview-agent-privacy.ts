import { contextBridge } from "electron";

import {
  installPreviewAgentPrivacyGuard,
  installPreviewAgentShadowBoundarySignal,
  PREVIEW_AGENT_NESTED_BOUNDARY_EVENT,
} from "../shared/preview-agent-privacy-guard.js";

installPreviewAgentPrivacyGuard();
contextBridge.executeInMainWorld({
  func: installPreviewAgentShadowBoundarySignal,
  args: [PREVIEW_AGENT_NESTED_BOUNDARY_EVENT],
});
