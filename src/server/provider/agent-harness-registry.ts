import { createClaudeAgentSdkHarness } from "./claude-agent-sdk-harness";
import { createCodexAppServerHarness } from "./codex-app-server-harness";
import { createCursorAcpHarness } from "./cursor-acp-harness";
import { createGeminiAcpHarness } from "./gemini-acp-harness";
import { createKimiAcpHarness } from "./kimi-acp-harness";
import { createOpenCodeSdkHarness } from "./opencode-sdk-harness";
import type {
  AgentHarness,
  AgentHarnessCapabilities,
  AgentHarnessId,
} from "./agent-harness";
import { ProviderRuntimeError, type ProviderId, type ProviderRunInput } from "./contracts";
import { providerIdForHarness } from "../../shared/model-routing";

const HARNESS_PROVIDERS: Readonly<Record<AgentHarnessId, ProviderId>> = {
  "codex-app-server": "codex",
  "codex-cli": "codex",
  "claude-cli": "claude",
  "cursor-cli": "cursor",
  "opencode-cli": "opencode",
  "claude-agent-sdk": "claude",
  "cursor-acp": "cursor",
  "gemini-acp": "gemini",
  "kimi-acp": "kimi",
  "opencode-sdk": "opencode",
};

export class AgentHarnessRegistry {
  private readonly harnesses: readonly AgentHarness[];

  constructor(harnesses: readonly AgentHarness[]) {
    const ids = new Set<AgentHarnessId>();
    for (const harness of harnesses) {
      if (ids.has(harness.id)) throw new Error(`Duplicate agent harness '${harness.id}'.`);
      if (harness.providerId !== HARNESS_PROVIDERS[harness.id]) {
        throw new Error(`Agent harness '${harness.id}' is registered for the wrong provider.`);
      }
      if (harness.capabilities.extension.kind !== harness.id) {
        throw new Error(`Agent harness '${harness.id}' has mismatched capabilities.`);
      }
      ids.add(harness.id);
    }
    this.harnesses = [...harnesses];
  }

  resolve(input: ProviderRunInput): AgentHarness {
    if (
      input.modelSelection.harnessId !== input.harnessId
      || input.modelSelection.backendProfileId !== input.backendProfile.id
      || input.backendCompatibility.harnessId !== input.harnessId
      || input.backendCompatibility.backendProfileId !== input.backendProfile.id
      || input.backendCompatibility.backendProtocol !== input.backendProfile.protocol
    ) {
      throw new ProviderRuntimeError("invalid_input", "The harness and backend route is internally inconsistent.");
    }
    const projectedProvider = providerIdForHarness(input.harnessId);
    if (!projectedProvider || projectedProvider !== input.providerId) {
      throw new ProviderRuntimeError("invalid_input", "The harness does not match its provider compatibility projection.");
    }
    if (
      input.backendCompatibility.state === "unknown"
      || input.backendCompatibility.state === "unavailable"
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `Backend '${input.backendProfile.displayName}' is not verified for '${input.harnessId}'.`,
      );
    }
    if (!input.backendProfile.enabled) {
      throw new ProviderRuntimeError("invalid_input", `Backend '${input.backendProfile.displayName}' is disabled.`);
    }
    if (input.backendProfile.source === "custom") {
      if (
        input.providerId === "cursor"
        || input.providerId === "gemini"
        || input.providerId === "kimi"
        || input.providerId === "opencode"
      ) {
        throw new ProviderRuntimeError(
          "invalid_input",
          input.providerId === "cursor"
            ? "Cursor controls its backend; external backend profiles cannot be injected."
            : input.providerId === "gemini"
              ? "Gemini CLI controls its backend; external backend profiles cannot be injected."
            : input.providerId === "kimi"
              ? "Kimi Code controls its backend; external backend profiles cannot be injected."
              : "OpenCode backends must come from OpenCode's native provider catalog.",
        );
      }
      if (input.backendCompatibility.provenance !== "probe") {
        throw new ProviderRuntimeError(
          "invalid_input",
          `Backend '${input.backendProfile.displayName}' requires current compatibility evidence.`,
        );
      }
    }
    const matches = this.harnesses.filter(
      (harness) => harness.id === input.harnessId && harness.supports(input),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new ProviderRuntimeError("invalid_input", `Agent harness '${input.harnessId}' is unavailable.`);
    }
    throw new ProviderRuntimeError("invalid_input", `Multiple agent harnesses matched '${input.harnessId}'.`);
  }

  capabilities(providerId?: ProviderId): readonly AgentHarnessCapabilities[] {
    return this.harnesses
      .filter((harness) => providerId === undefined || harness.providerId === providerId)
      .map((harness) => harness.capabilities);
  }

  list(providerId?: ProviderId): readonly AgentHarness[] {
    return this.harnesses.filter((harness) => providerId === undefined || harness.providerId === providerId);
  }
}

export function createDefaultAgentHarnessRegistry(): AgentHarnessRegistry {
  return new AgentHarnessRegistry([
    createCodexAppServerHarness(),
    createClaudeAgentSdkHarness(),
    createCursorAcpHarness(),
    createGeminiAcpHarness(),
    createKimiAcpHarness(),
    createOpenCodeSdkHarness(),
  ]);
}
