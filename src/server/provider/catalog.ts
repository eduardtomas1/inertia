import { PROVIDER_IDS, type ProviderId, type ProviderInfo } from "./contracts";

export const PROVIDER_INFO: Readonly<Record<ProviderId, ProviderInfo>> = Object.freeze({
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
  },
  claude: {
    id: "claude",
    name: "Claude",
    command: "claude",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    command: "agent",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
  },
});

export const PROVIDERS: readonly ProviderInfo[] = PROVIDER_IDS.map((id) => PROVIDER_INFO[id]);
