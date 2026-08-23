import { contextBridge, ipcRenderer } from "electron";

import {
  installPreviewAgentPrivacyGuard,
  PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL,
  installPreviewAgentShadowBoundarySignal,
  PREVIEW_AGENT_NESTED_BOUNDARY_EVENT,
} from "../shared/preview-agent-privacy-guard.js";

installPreviewAgentPrivacyGuard((refusal) => {
  ipcRenderer.sendSync(PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL, refusal);
});
contextBridge.executeInMainWorld({
  func: installPreviewAgentShadowBoundarySignal,
  args: [PREVIEW_AGENT_NESTED_BOUNDARY_EVENT],
});
