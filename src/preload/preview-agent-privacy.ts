import { contextBridge, ipcRenderer } from "electron";

import {
  installPreviewAgentPrivacyGuard,
  PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL,
  installPreviewAgentShadowBoundarySignal,
  PREVIEW_AGENT_CREDENTIAL_SIGNAL_EVENT,
  PREVIEW_AGENT_NESTED_BOUNDARY_EVENT,
} from "../shared/preview-agent-privacy-guard.js";
import { createPreviewAgentPrivacyRuntime } from "../shared/preview-agent-sensitive-fields.js";

installPreviewAgentPrivacyGuard(createPreviewAgentPrivacyRuntime(), (refusal) => {
  ipcRenderer.sendSync(PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL, refusal);
});
contextBridge.executeInMainWorld({
  func: installPreviewAgentShadowBoundarySignal,
  args: [PREVIEW_AGENT_NESTED_BOUNDARY_EVENT, PREVIEW_AGENT_CREDENTIAL_SIGNAL_EVENT],
});
