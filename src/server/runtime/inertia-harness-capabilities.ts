import type {
  ProviderHostToolDefinition,
} from "../provider/contracts";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  RETIRED_AGENT_BROWSER_TOOL_DEFINITIONS,
} from "./agent-browser-host-tools";
import { HTML_RENDER_TOOL_DEFINITION } from "./html-render-host-tool";
import {
  HarnessCapabilityRegistry,
  type HarnessCapabilityTool,
  type HarnessCapabilityPack,
} from "./harness-capabilities";
import type { HiddenProviderInstruction } from "./turns/request-context";

const ORCHESTRATION_INSTRUCTION: HiddenProviderInstruction = {
  label: "inertia-orchestration",
  text: [
    "Chat tools start real top-level chats: delegate only concrete, independent work with an explicit owner and success criteria, never as hidden subagents.",
    "A started chat is not finished work; read its status and latest result before relying on it.",
    "Inertia asks the user before every call that changes a chat, whatever the access mode.",
  ].join(" "),
};

const FRONTEND_INSTRUCTION: HiddenProviderInstruction = {
  label: "inertia-frontend-workbench",
  text: [
    "For frontend work, snapshot before and after each meaningful UI change and exercise the real interaction path.",
    "The snapshot audit flags missing control names and clipped, overlapping or small controls in the current viewport: deterministic signals, not a full visual judgment; re-check after the viewport changes.",
    "When a Browser tool fails, follow its message before giving up on the Browser.",
    "Report only evidence you observed.",
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
    revision: 3,
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
    revision: 4,
    title: "Inertia frontend workbench",
    summary: "Visible local-page interaction with bounded semantic inspection and deterministic frontend audit evidence.",
    instructions: [FRONTEND_INSTRUCTION],
    tools: AGENT_BROWSER_TOOL_DEFINITIONS.map((definition) => ({
      definition,
      invoke: input.invoke,
    })),
    retiredTools: RETIRED_AGENT_BROWSER_TOOL_DEFINITIONS.map((definition) => ({
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
  packs.push({
    id: "inertia.visual-replies",
    revision: 2,
    title: "Inertia visual replies",
    summary: "One sandboxed, self-contained HTML page per call, shown inline above the turn's written reply.",
    instructions: [],
    tools: [{ definition: HTML_RENDER_TOOL_DEFINITION, invoke: input.invoke }],
    evaluation: {
      tags: ["frontend", "visual-replies"],
      evidenceKinds: ["host-tool-result"],
      scenarioIds: ["inline-rendered-page", "exact-turn-render"],
    },
  });
  return new HarnessCapabilityRegistry(packs);
}
