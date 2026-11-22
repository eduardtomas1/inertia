import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AgentTurn, Conversation } from "../../src/shared/contracts";
import { SECRET_REQUEST_TOOL_NAME } from "../../src/node/agent-secrets";
import type { ProviderHostToolDefinition } from "../../src/server/provider/contracts";
import { providerMcpTools } from "../../src/server/provider/host-tool-mcp-protocol";
import { SECRET_REQUEST_TOOL_DEFINITION } from "../../src/server/runtime/agent-secrets/secret-request-host-tool";
import { SEND_TO_USER_TOOL_DEFINITION } from "../../src/server/runtime/send-to-user-host-tool";
import { SEND_TO_USER_TOOL_NAME } from "../../src/shared/send-to-user";
import {
  HarnessCapabilityRegistry,
  harnessCapabilityPacksOf,
  type HarnessCapabilityPack,
} from "../../src/server/runtime/harness-capabilities";
import {
  claudeAdvertisedSurface,
  codexAdvertisedSurface,
  createSurfaceRuntime,
  httpMcpAdvertisedSurface,
} from "../helpers/agent-tool-surface";

const ALWAYS_LOAD = "anthropic/alwaysLoad";
// A model that cannot see either tool falls back to chat: it asks for the
// secret there, or writes the message as pre-tool text that arrives summarized.
const ALWAYS_LOADED = [SECRET_REQUEST_TOOL_NAME, SEND_TO_USER_TOOL_NAME];

function definition(name: string, alwaysLoad?: boolean): ProviderHostToolDefinition {
  return {
    name,
    description: `Run ${name}.`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    inputValidator: z.object({}).strict(),
    readOnly: true,
    ...(alwaysLoad === undefined ? {} : { alwaysLoad }),
  };
}

function pack(id: string, tool: ProviderHostToolDefinition): HarnessCapabilityPack {
  return {
    id,
    revision: 1,
    title: `Pack ${id}`,
    summary: `Summary of ${id}.`,
    instructions: [],
    tools: [{ definition: tool, invoke: vi.fn(async () => ({ success: true, text: "{}" })) }],
    evaluation: { tags: [id], evidenceKinds: ["host-tool-result"], scenarioIds: [`${id}-scenario`] },
  };
}

describe("anthropic/alwaysLoad", () => {
  it("is set on inertia_request_secret and inertia_send_to_user and on no other Inertia tool", async () => {
    expect(SECRET_REQUEST_TOOL_DEFINITION.alwaysLoad).toBe(true);
    expect(SEND_TO_USER_TOOL_DEFINITION.alwaysLoad).toBe(true);
    const runtime = await createSurfaceRuntime({ browser: { perform: async () => ({ ok: false, code: "unavailable", message: "Not used." }) }, cadAccess: true });
    try {
      expect(runtime.bridge.definitions.filter(({ alwaysLoad }) => alwaysLoad).map(({ name }) => name))
        .toEqual(ALWAYS_LOADED);
    } finally {
      await runtime.close();
    }
  });

  it("reaches Claude's tools/list for those tools only, and no other transport", async () => {
    const runtime = await createSurfaceRuntime();
    try {
      const claude = await claudeAdvertisedSurface(runtime.bridge);
      const marked = claude.tools.filter((tool) => tool._meta !== undefined);
      expect(marked.map(({ name }) => name)).toEqual(ALWAYS_LOADED);
      for (const tool of marked) expect(tool._meta).toEqual({ [ALWAYS_LOAD]: true });
      for (const surface of [
        await codexAdvertisedSurface(runtime.bridge),
        await httpMcpAdvertisedSurface(runtime.bridge, {}),
        await httpMcpAdvertisedSurface(runtime.bridge, { destructiveHints: true }),
      ]) {
        expect(surface.tools.some((tool) => "_meta" in tool)).toBe(false);
        expect(JSON.stringify(surface.tools)).not.toContain(ALWAYS_LOAD);
      }
    } finally {
      await runtime.close();
    }
  });

  it("leaves every other tool's MCP entry byte-for-byte unchanged", () => {
    const definitions = [definition("inertia_plain_tool"), definition("inertia_false_tool", false), definition("inertia_loaded_tool", true)];
    const plain = providerMcpTools(definitions, { destructiveHints: true });
    const claude = providerMcpTools(definitions, { destructiveHints: true, alwaysLoadMeta: true });
    expect(JSON.stringify(claude.slice(0, 2))).toBe(JSON.stringify(plain.slice(0, 2)));
    expect(claude[2]).toEqual({ ...plain[2], _meta: { [ALWAYS_LOAD]: true } });
    expect(plain[2]).not.toHaveProperty("_meta");
  });

  it("enters a pack's definition digest only when set, so other tools and packs keep their digests", () => {
    const digests = (tool: ProviderHostToolDefinition): Record<string, string> => {
      const registry = new HarnessCapabilityRegistry([pack("inertia.alpha", tool), pack("inertia.zeta", definition("inertia_zeta_tool"))]);
      const packs = harnessCapabilityPacksOf(registry.bridgeFor({ conversation: {} as Conversation, turn: {} as AgentTurn }))!;
      return { all: registry.manifest().definitionDigest, ...Object.fromEntries(packs.map(({ id, digest }) => [id, digest])) };
    };
    const unset = digests(definition("inertia_alpha_tool"));
    expect(digests(definition("inertia_alpha_tool", false))).toEqual(unset);
    const set = digests(definition("inertia_alpha_tool", true));
    expect(set["inertia.zeta"]).toBe(unset["inertia.zeta"]);
    expect(set["inertia.alpha"]).not.toBe(unset["inertia.alpha"]);
    expect(set.all).not.toBe(unset.all);
  });
});
