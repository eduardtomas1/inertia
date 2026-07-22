import { createCliAgentHarness } from "./cli-agent-harness";
import { createCodexAppServerHarness } from "./codex-app-server-harness";
import type {
  AgentHarness,
  AgentHarnessCapabilities,
  AgentHarnessId,
} from "./agent-harness";
import { ProviderRuntimeError, type ProviderId, type ProviderRunInput } from "./contracts";

const HARNESS_PROVIDERS: Readonly<Record<AgentHarnessId, ProviderId>> = {
  "codex-app-server": "codex",
  "codex-cli": "codex",
  "claude-cli": "claude",
  "cursor-cli": "cursor",
  "opencode-cli": "opencode",
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
    const matches = this.harnesses.filter((harness) => harness.providerId === input.providerId && harness.supports(input));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new ProviderRuntimeError("invalid_input", `No agent harness can run ${input.providerId} with the selected options.`);
    }
    throw new ProviderRuntimeError("invalid_input", `Multiple agent harnesses matched ${input.providerId} with the selected options.`);
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
    createCliAgentHarness("codex", { supports: (input) => input.providerId === "codex" && input.access === "full" }),
    createCliAgentHarness("claude"),
    createCliAgentHarness("cursor"),
    createCliAgentHarness("opencode"),
  ]);
}
