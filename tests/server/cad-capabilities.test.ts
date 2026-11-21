// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  codexThreadStartTools,
  recordCodexThreadRegistration,
} from "../../src/server/codex/app-server-thread-tools";
import type { ProviderHostToolBridge, ProviderHostToolResult } from "../../src/server/provider/contracts";
import { AGENT_BROWSER_TOOL_DEFINITIONS } from "../../src/server/runtime/agent-browser-host-tools";
import { CAD_INSTRUCTION, CAD_TOOL_NAMES } from "../../src/server/runtime/cad-host-tools";
import { harnessCapabilityPacksOf } from "../../src/server/runtime/harness-capabilities";
import {
  CAD_ACCESS_DISABLED,
  createInertiaHarnessCapabilities,
  INERTIA_CAD_PACK_ID,
  INERTIA_FRONTEND_WORKBENCH_PACK_ID,
  inertiaCapabilityOfferForProject,
} from "../../src/server/runtime/inertia-harness-capabilities";
import type { AgentTurn, Conversation } from "../../src/shared/contracts";
import {
  defaultProjectPreferences,
  parseProjectPreferences,
} from "../../src/shared/project-preferences";
import { createSurfaceRuntime, type SurfaceRuntime } from "../helpers/agent-tool-surface";

const runtimes: SurfaceRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
});

async function surface(cadAccess?: boolean): Promise<SurfaceRuntime> {
  const runtime = await createSurfaceRuntime(cadAccess === undefined ? {} : { cadAccess });
  runtimes.push(runtime);
  return runtime;
}

async function invoke(bridge: ProviderHostToolBridge, tool: string, args: unknown = {}): Promise<ProviderHostToolResult> {
  return await bridge.invoke({
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => "approve" as const),
  });
}

const errorCode = (result: ProviderHostToolResult): unknown =>
  (JSON.parse(result.text) as { error?: { code?: unknown } }).error?.code;

const cadNames = (definitions: readonly { name: string }[]): string[] =>
  definitions.map(({ name }) => name).filter((name) => name.startsWith("inertia_cad_"));

describe("CAD tools in a project that has not turned them on", () => {
  it("are not advertised and their instruction is not offered", async () => {
    const runtime = await surface();
    expect(runtime.store.project(runtime.project.id).preferences?.cadAccess ?? null).toBeNull();
    expect(cadNames(runtime.bridge.definitions)).toEqual([]);
    const labels = runtime.manager.capabilityOfferForTurn(runtime.source).instructions.map(({ label }) => label);
    expect(labels).not.toContain(CAD_INSTRUCTION.label);
    expect(runtime.bridge.instructions?.map(({ label }) => label)).not.toContain(CAD_INSTRUCTION.label);
  });

  it.each([...CAD_TOOL_NAMES])("answer cad_disabled when %s is called anyway", async (tool) => {
    const runtime = await surface();
    const result = await invoke(runtime.bridge, tool);
    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe(CAD_ACCESS_DISABLED.code);
  });

  it("are left out of a new Codex thread", async () => {
    const runtime = await surface();
    expect(cadNames(codexThreadStartTools(runtime.bridge))).toEqual([]);
  });

  it("leave no inertia.cad digest in the thread registration", async () => {
    const runtime = await surface();
    const threadId = `codex-thread-${randomUUID()}`;
    recordCodexThreadRegistration(threadId, runtime.bridge);
    const recorded = runtime.store.codexThreadToolPacks.read(threadId);
    expect(recorded).not.toBeNull();
    expect(recorded!.has(INERTIA_CAD_PACK_ID)).toBe(false);
    expect(recorded!.has("inertia.workspace")).toBe(true);
  });

  it("treat an explicit false like the default", async () => {
    const runtime = await surface(false);
    expect(cadNames(runtime.bridge.definitions)).toEqual([]);
    expect(errorCode(await invoke(runtime.bridge, "inertia_cad_status"))).toBe("cad_disabled");
  });
});

describe("CAD tools in a project that turned them on", () => {
  it("advertise all eight tools and the inertia-cad instruction", async () => {
    const runtime = await surface(true);
    expect(cadNames(runtime.bridge.definitions).sort()).toEqual([...CAD_TOOL_NAMES].sort());
    const instructions = runtime.manager.capabilityOfferForTurn(runtime.source).instructions;
    expect(instructions).toContainEqual(CAD_INSTRUCTION);
  });

  it("reach the CAD service", async () => {
    const runtime = await surface(true);
    const result = await invoke(runtime.bridge, "inertia_cad_status");
    expect(result.success).toBe(true);
    // No exporter is wired in this surface, so AutoCAD's console is not available.
    expect(JSON.parse(result.text)).toEqual({ hosts: [], documents: [], headless: false });
  });

  it("are registered on a new Codex thread and recorded with their digest", async () => {
    const runtime = await surface(true);
    expect(cadNames(codexThreadStartTools(runtime.bridge)).sort()).toEqual([...CAD_TOOL_NAMES].sort());
    const threadId = `codex-thread-${randomUUID()}`;
    recordCodexThreadRegistration(threadId, runtime.bridge);
    const digest = harnessCapabilityPacksOf(runtime.bridge)!.find(({ id }) => id === INERTIA_CAD_PACK_ID)!.digest;
    expect(runtime.store.codexThreadToolPacks.read(threadId)?.get(INERTIA_CAD_PACK_ID)).toBe(digest);
  });

  it("answer cad_disabled once the setting is turned off mid-turn", async () => {
    const runtime = await surface(true);
    expect((await invoke(runtime.bridge, "inertia_cad_status")).success).toBe(true);
    const preferences = runtime.store.project(runtime.project.id).preferences ?? defaultProjectPreferences();
    runtime.store.updateProject(runtime.project.id, { preferences: { ...preferences, cadAccess: false } });
    const result = await invoke(runtime.bridge, "inertia_cad_status");
    expect(result.success).toBe(false);
    expect(errorCode(result)).toBe("cad_disabled");
    expect(cadNames(runtime.manager.bridgeFor({ conversation: runtime.source, turn: runtime.sourceTurn }).definitions)).toEqual([]);
  });
});

describe("CAD and Browser offers together", () => {
  function bridgeFor(preferences: { browserAccess: boolean | null; cadAccess: boolean | null }) {
    return createInertiaHarnessCapabilities({
      orchestrationTools: [],
      browserEnabled: true,
      cadEnabled: true,
      invoke: async () => ({ success: true, text: "{}" }),
    }).bridgeFor(
      { conversation: {} as Conversation, turn: {} as AgentTurn },
      inertiaCapabilityOfferForProject(preferences),
    );
  }

  const BROWSER_TOOLS = AGENT_BROWSER_TOOL_DEFINITIONS.map(({ name }) => name);
  const browserNames = (definitions: readonly { name: string }[]): string[] =>
    definitions.map(({ name }) => name).filter((name) => BROWSER_TOOLS.includes(name));

  it("still registers withheld Browser tools on a new Codex thread, but not withheld CAD tools", () => {
    const bridge = bridgeFor({ browserAccess: false, cadAccess: null });
    const started = codexThreadStartTools(bridge);
    expect(browserNames(started).sort()).toEqual([...BROWSER_TOOLS].sort());
    expect(cadNames(started)).toEqual([]);
    expect(browserNames(bridge.definitions)).toEqual([]);
  });

  it("registers both when CAD is on and Browser is off", () => {
    const bridge = bridgeFor({ browserAccess: false, cadAccess: true });
    const started = codexThreadStartTools(bridge);
    expect(browserNames(started)).toHaveLength(BROWSER_TOOLS.length);
    expect(cadNames(started)).toHaveLength(CAD_TOOL_NAMES.size);
  });

  it("withholds each pack for its own reason", async () => {
    const offer = inertiaCapabilityOfferForProject({ browserAccess: false, cadAccess: null });
    expect([...offer.withheldPacks.keys()].sort()).toEqual([INERTIA_CAD_PACK_ID, INERTIA_FRONTEND_WORKBENCH_PACK_ID].sort());
    const bridge = bridgeFor({ browserAccess: false, cadAccess: null });
    expect(errorCode(await invoke(bridge, "inertia_cad_query_objects"))).toBe("cad_disabled");
    expect(errorCode(await invoke(bridge, BROWSER_TOOLS[0]!))).toBe("browser_disabled");
  });

  it("withholds only CAD by default, and nothing once both are on", () => {
    expect([...inertiaCapabilityOfferForProject(null).withheldPacks.keys()]).toEqual([INERTIA_CAD_PACK_ID]);
    expect([...inertiaCapabilityOfferForProject(defaultProjectPreferences()).withheldPacks.keys()]).toEqual([INERTIA_CAD_PACK_ID]);
    expect(inertiaCapabilityOfferForProject({ browserAccess: null, cadAccess: true }).withheldPacks.size).toBe(0);
  });
});

describe("cadAccess project preference", () => {
  it("defaults to null", () => {
    expect(defaultProjectPreferences().cadAccess).toBeNull();
  });

  it("parses preferences saved before the key existed", () => {
    const { cadAccess: _cadAccess, ...older } = { ...defaultProjectPreferences(), browserAccess: false, pinned: true };
    const parsed = parseProjectPreferences(JSON.stringify(older));
    expect(parsed).toMatchObject({ browserAccess: false, pinned: true, cadAccess: null });
  });

  it("keeps a saved choice", () => {
    expect(parseProjectPreferences({ ...defaultProjectPreferences(), cadAccess: true }).cadAccess).toBe(true);
    expect(parseProjectPreferences({ ...defaultProjectPreferences(), cadAccess: false }).cadAccess).toBe(false);
  });
});
