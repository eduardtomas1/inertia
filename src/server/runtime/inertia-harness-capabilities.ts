import type {
  ProviderHostToolDefinition,
} from "../provider/contracts";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
} from "./agent-browser-host-tools";
import {
  HarnessCapabilityRegistry,
  type HarnessCapabilityTool,
  type HarnessCapabilityPack,
} from "./harness-capabilities";
import type { HiddenProviderInstruction } from "./turns/request-context";

const ORCHESTRATION_INSTRUCTION: HiddenProviderInstruction = {
  label: "inertia-orchestration",
  text: [
    "Inertia exposes exact-turn tools for bounded top-level chat orchestration.",
    "Delegate only concrete independent work, keep ownership and success criteria explicit, and do not create chats merely to imitate hidden subagents.",
    "After dispatch, inspect status and read the bounded terminal result before relying on delegated work; a started chat is not evidence of completion.",
    "Never infer approval from access mode: Inertia remains the authority for every host mutation.",
  ].join(" "),
};

const FRONTEND_INSTRUCTION: HiddenProviderInstruction = {
  label: "inertia-frontend-workbench",
  text: [
    "When frontend work has a live Inertia Browser, use its semantic snapshot before and after meaningful UI changes.",
    "The snapshot includes an Inertia audit for stable control names, clipped controls, overlapping controls, and small targets in the current viewport; treat these as deterministic signals, not a complete visual judgment.",
    "Exercise the real interaction path when useful, repeat checks after the user or layout changes the viewport, and report which evidence was actually observed.",
    "The local screenshot tool records pixels for the user but does not show those pixels to you, so never claim visual parity from that capture alone.",
  ].join(" "),
};

interface InertiaHarnessCapabilityInput {
  orchestrationTools: readonly ProviderHostToolDefinition[];
  browserEnabled: boolean;
  invoke: HarnessCapabilityTool["invoke"];
}

export function createInertiaHarnessCapabilities(
  input: InertiaHarnessCapabilityInput,
): HarnessCapabilityRegistry {
  const packs: HarnessCapabilityPack[] = [{
    id: "inertia.orchestration",
    revision: 1,
    title: "Inertia orchestration",
    summary: "Bounded, approval-owned coordination of independent top-level Inertia chats.",
    instructions: [ORCHESTRATION_INSTRUCTION],
    tools: input.orchestrationTools.map((definition) => ({
      definition,
      invoke: input.invoke,
    })),
    evaluation: {
      tags: ["orchestration", "permissions", "recovery", "subagents"],
      evidenceKinds: ["host-tool-result", "provider-event"],
      scenarioIds: [
        "delegation-bounds",
        "exact-turn-authority",
        "terminal-result-observation",
      ],
    },
  }];
  if (input.browserEnabled) packs.push({
    id: "inertia.frontend-workbench",
    revision: 1,
    title: "Inertia frontend workbench",
    summary: "Visible local-page interaction with bounded semantic inspection and deterministic frontend audit evidence.",
    instructions: [FRONTEND_INSTRUCTION],
    tools: AGENT_BROWSER_TOOL_DEFINITIONS.map((definition) => ({
      definition,
      invoke: input.invoke,
    })),
    evaluation: {
      tags: ["accessibility", "browser", "frontend", "responsive"],
      evidenceKinds: ["browser-evidence", "host-tool-result"],
      scenarioIds: [
        "frontend-audit",
        "semantic-browser-loop",
        "current-viewport-regression",
      ],
    },
  });
  return new HarnessCapabilityRegistry(packs);
}
