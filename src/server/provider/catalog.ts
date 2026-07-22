import { PROVIDER_IDS, type ProviderId, type ProviderInfo } from "./contracts";

export const PROVIDER_INFO: Readonly<Record<ProviderId, ProviderInfo>> = Object.freeze({
  codex: {
    id: "codex",
    name: "Codex",
    command: "codex",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--dangerously-bypass-approvals-and-sandbox",
    },
  },
  claude: {
    id: "claude",
    name: "Claude",
    command: "claude",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--dangerously-skip-permissions",
    },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: false,
      fullAccessFlag: "--force",
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    capabilities: {
      resume: true,
      images: true,
      nativePlanMode: true,
      fullAccessFlag: "--auto",
    },
  },
});

export const PROVIDERS: readonly ProviderInfo[] = PROVIDER_IDS.map((id) => PROVIDER_INFO[id]);
