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

  it("owns and deeply freezes tool schemas used by definitions and the digest", () => {
    const originalSchema = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["safe", "thorough"],
        },
      },
      required: ["mode"],
      additionalProperties: false,
    };
    const mutable = pack("inertia.schema", "inertia_schema_tool");
    mutable.tools[0]!.definition.inputSchema = originalSchema;
    const registry = new HarnessCapabilityRegistry([mutable]);
    const digest = registry.manifest().definitionDigest;
    const ownedSchema = registry.bridgeFor(context).definitions[0]!.inputSchema;

    originalSchema.properties.mode.type = "number";
    originalSchema.properties.mode.enum[0] = "mutated";
    originalSchema.required.push("mutated");

    expect(ownedSchema).toEqual({
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["safe", "thorough"],
        },
      },
      required: ["mode"],
      additionalProperties: false,
    });
    expect(registry.manifest().definitionDigest).toBe(digest);
    expect(Object.isFrozen(ownedSchema)).toBe(true);
    const ownedProperties = ownedSchema.properties as Record<string, {
      type: string;
      enum: string[];
    }>;
    expect(Object.isFrozen(ownedProperties)).toBe(true);
    expect(Object.isFrozen(ownedProperties.mode)).toBe(true);
    expect(Object.isFrozen(ownedProperties.mode.enum)).toBe(true);
    const ownedRequired = ownedSchema.required as string[];
    expect(Object.isFrozen(ownedRequired)).toBe(true);
    expect(() => { ownedProperties.mode.type = "number"; }).toThrow(TypeError);
    expect(() => { ownedProperties.mode.enum[0] = "mutated"; }).toThrow(TypeError);
    expect(() => { ownedRequired.push("mutated"); }).toThrow(TypeError);

    const changed = pack("inertia.schema", "inertia_schema_tool");
    changed.tools[0]!.definition.inputSchema = {
      ...originalSchema,
      properties: {
        mode: { type: "string", enum: ["different", "thorough"] },
      },
    };
    expect(new HarnessCapabilityRegistry([changed]).manifest().definitionDigest)
      .not.toBe(digest);
  });

  it("rejects schemas that cannot be owned as bounded JSON", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    const invalid = pack("inertia.invalid", "inertia_invalid_tool");
    invalid.tools[0]!.definition.inputSchema = cyclic;
    expect(() => new HarnessCapabilityRegistry([invalid])).toThrow(
      "input schema contains a cycle",
    );

    const unsupported = pack("inertia.unsupported", "inertia_unsupported_tool");
    unsupported.tools[0]!.definition.inputSchema = {
      type: "object",
      unsupported: undefined,
    };
    expect(() => new HarnessCapabilityRegistry([unsupported])).toThrow(
      "input schema contains a non-JSON value",
    );

    const oversized = pack("inertia.oversized", "inertia_oversized_tool");
    oversized.tools[0]!.definition.inputSchema = {
      type: "string",
      description: "x".repeat(64 * 1024),
    };
    expect(() => new HarnessCapabilityRegistry([oversized])).toThrow(
      "input schema exceeds its byte limit",
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
