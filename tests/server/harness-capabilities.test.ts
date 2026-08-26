import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AgentTurn, Conversation } from "../../src/shared/contracts";
import type {
  ProviderHostToolCall,
} from "../../src/server/provider/contracts";
import {
  HarnessCapabilityRegistry,
  type HarnessCapabilityPack,
} from "../../src/server/runtime/harness-capabilities";

const context = {
  conversation: { providerId: "codex" } as Conversation,
  turn: { harnessId: "codex-app-server" } as AgentTurn,
};

function call(tool: string): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: {},
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => "approve" as const),
  };
}

function pack(
  id: string,
  toolName: string,
  instructionLabel = `${id}-instruction`,
): HarnessCapabilityPack {
  return {
    id,
    revision: 1,
    title: `Pack ${id}`,
    summary: `Safe summary for ${id}.`,
    instructions: [{
      label: instructionLabel,
      text: `Private provider guidance for ${id}.`,
    }],
    tools: [{
      definition: {
        name: toolName,
        description: `Run ${toolName}.`,
        inputSchema: { type: "object", additionalProperties: false },
        inputValidator: z.object({}).strict(),
        readOnly: true,
      },
      invoke: vi.fn(async () => ({ success: true, text: `{"tool":"${toolName}"}` })),
    }],
    evaluation: {
      tags: [id],
      evidenceKinds: ["host-tool-result"],
      scenarioIds: [`${id}-scenario`],
    },
  };
}

describe("HarnessCapabilityRegistry", () => {
  it("composes packs deterministically and routes an exact tool", async () => {
    const first = pack("inertia.zeta", "inertia_zeta_tool");
    const second = pack("inertia.alpha", "inertia_alpha_tool");
    const registry = new HarnessCapabilityRegistry([first, second]);
    const reversed = new HarnessCapabilityRegistry([second, first]);

    expect(registry.manifest()).toEqual(reversed.manifest());
    expect(registry.manifest().packs.map(({ id }) => id)).toEqual([
      "inertia.alpha",
      "inertia.zeta",
    ]);
    expect(JSON.stringify(registry.manifest())).not.toContain("Private provider guidance");
    expect(registry.instructions().map(({ label }) => label)).toEqual([
      "inertia.alpha-instruction",
      "inertia.zeta-instruction",
    ]);

    second.instructions[0]!.text = "Mutated after registration.";
    second.tools[0]!.definition.name = "inertia_mutated_tool";
    expect(registry.instructions()[0]!.text).toBe(
      "Private provider guidance for inertia.alpha.",
    );

    const bridge = registry.bridgeFor(context);
    expect(bridge.definitions[0]!.name).toBe("inertia_alpha_tool");
    await expect(bridge.invoke(call("inertia_alpha_tool"))).resolves.toEqual({
      success: true,
      text: "{\"tool\":\"inertia_alpha_tool\"}",
    });
    expect(second.tools[0]!.invoke).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ tool: "inertia_alpha_tool" }),
    );
  });

  it("rejects conflicting identities and tools before a provider starts", () => {
    expect(() => new HarnessCapabilityRegistry([
      pack("inertia.same", "inertia_first_tool"),
      pack("inertia.same", "inertia_second_tool", "second-label"),
    ])).toThrow("duplicate Inertia capability pack");
    expect(() => new HarnessCapabilityRegistry([
      pack("inertia.first", "inertia_same_tool"),
      pack("inertia.second", "inertia_same_tool", "second-label"),
    ])).toThrow("duplicate Inertia capability tool");
    expect(() => new HarnessCapabilityRegistry([
      pack("inertia.first", "inertia_first_tool", "shared-label"),
      pack("inertia.second", "inertia_second_tool", "shared-label"),
    ])).toThrow("duplicate capability instruction");
  });

  it("requires a process-local validator and fails unknown calls closed", async () => {
    const invalid = pack("inertia.invalid", "inertia_invalid_tool");
    invalid.tools[0]!.definition.inputValidator = undefined;
    expect(() => new HarnessCapabilityRegistry([invalid])).toThrow(
      "has no runtime validator",
    );

    const registry = new HarnessCapabilityRegistry([
      pack("inertia.safe", "inertia_safe_tool"),
    ]);
    await expect(registry.bridgeFor(context).invoke(call("inertia_missing_tool")))
      .resolves.toEqual({
        success: false,
        text: JSON.stringify({
          error: {
            code: "capability_rejected",
            message: "That Inertia capability tool is unavailable.",
          },
        }),
      });
  });
});
