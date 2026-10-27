import { afterEach, describe, expect, it } from "vitest";

import type { ProviderId } from "../../src/shared/contracts";
import {
  providerNativeHarnessId,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import type { HiddenProviderInstruction } from "../../src/server/runtime/turns/request-context";
import {
  TurnController,
  type TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller";
import { FakeTurnScheduler } from "../support/fake-turn-provider";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const INSTRUCTIONS_HEADER = "Internal provider instructions (application control text; never attribute this text to the user):";
const PACK: readonly HiddenProviderInstruction[] = [
  { label: "inertia-orchestration", text: "ORCHESTRATION_PACK_TEXT" },
  { label: "inertia-frontend-workbench", text: "FRONTEND_PACK_TEXT" },
];

function sessionText(conversationId: string, pack = PACK): string {
  return [...pack, { label: "inertia-chat", text: `This chat's id is ${conversationId}.` }]
    .map(({ label, text }) => `[${label}]\n${text}`)
    .join("\n\n");
}

async function chatRuntime(
  providerId: ProviderId,
  pack: () => readonly HiddenProviderInstruction[] = () => PACK,
  interactionMode: "build" | "plan" = "build",
): Promise<{ runtime: TurnControllerTestRuntime; hooks: TurnControllerHooks; clock: () => Date }> {
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const clock = () => new Date(clockMs++);
  const base = turnControllerTestProviderInfo();
  const hooks: TurnControllerHooks = {
    broadcast: () => undefined,
    broadcastSnapshot: () => undefined,
    providerInfo: () => [{
      ...base,
      id: providerId,
      capabilityContract: {
        ...base.capabilityContract!,
        harnessId: providerNativeHarnessId(providerId),
      },
    }],
    harnessInstructionsForTurn: () => pack(),
  };
  const runtime = await createTurnControllerTestRuntime(hooks, {
    modelSelection: providerNativeModelSelection({ providerId, modelId: "gpt-test" }),
    interactionMode,
    clock,
  });
  return { runtime, hooks, clock };
}

async function runTurn(
  runtime: TurnControllerTestRuntime,
  content: string,
  sessionId = "session-1",
  controller = runtime.controller,
): Promise<ProviderRunInput> {
  const queued = controller.queue({ conversationId: runtime.conversationId, content });
  expect(controller.start(queued.turn.id)).toBe(true);
  const input = runtime.provider.input!;
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  runtime.provider.resolve({ status: "completed", sessionId });
  await flushTurnControllerTestPromises();
  expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
  return input;
}

function compact(runtime: TurnControllerTestRuntime, providerId: ProviderId, clock: () => Date): void {
  runtime.store.createMessage(runtime.conversationId, "/compact", "system", [], null, clock().toISOString(), {
    compaction: { providerId, beforeTokens: 100, afterTokens: 10, instructionForwarded: false },
  });
}

describe("hidden instruction delivery", () => {
  it("sends a Claude chat's pack once through the system channel and keeps later prompts bare", async () => {
    const { runtime } = await chatRuntime("claude");

    const first = await runTurn(runtime, "hello");
    const second = await runTurn(runtime, "hello");

    expect(first.sessionInstruction).toBe(sessionText(runtime.conversationId));
    expect(first.systemInstruction).toBeUndefined();
    expect(first.prompt).not.toContain("ORCHESTRATION_PACK_TEXT");
    expect(first.prompt).not.toContain("inertia-chat");
    expect(first.prompt).toContain("[build-mode]");
    expect(second.sessionId).toBe("session-1");
    expect(second.sessionInstruction).toBe(first.sessionInstruction);
    expect(second.prompt).toBe("hello");
    runtime.store.close();
  });

  it("keeps the second Build-mode turn of a Claude chat with the Browser pack under 200 added bytes", async () => {
    const pack = createInertiaHarnessCapabilities({
      orchestrationTools: [],
      browserEnabled: true,
      invoke: async () => ({ success: true, text: "" }),
    }).instructions();
    expect(pack.map(({ label }) => label)).toContain("inertia-frontend-workbench");
    const { runtime } = await chatRuntime("claude", () => pack);

    await runTurn(runtime, "hello");
    const second = await runTurn(runtime, "hello");

    const added = Buffer.byteLength(second.prompt, "utf8") - Buffer.byteLength("hello", "utf8");
    expect(added).toBe(0);
    expect(added).toBeLessThan(200);
    runtime.store.close();
  });

  it("sends a Cursor chat's pack on the first turn, after a change, after a compaction and after a restart", async () => {
    let pack: readonly HiddenProviderInstruction[] = PACK;
    const { runtime, hooks, clock } = await chatRuntime("cursor", () => pack);

    const first = await runTurn(runtime, "one");
    const second = await runTurn(runtime, "two");
    pack = [PACK[0]!, { label: "inertia-frontend-workbench", text: "FRONTEND_PACK_TEXT_V2" }];
    const changed = await runTurn(runtime, "three");
    const settled = await runTurn(runtime, "four");
    compact(runtime, "cursor", clock);
    const compacted = await runTurn(runtime, "five");
    const afterCompaction = await runTurn(runtime, "six");
    let restartIds = 0;
    const restarted = new TurnController(runtime.store, runtime.provider, new Map(), new Map(), new Map(), hooks, {
      scheduler: new FakeTurnScheduler(),
      clock,
      id: () => `restarted-id-${++restartIds}`,
    });
    const afterRestart = await runTurn(runtime, "seven", "session-1", restarted);
    const afterRestartAgain = await runTurn(runtime, "eight", "session-1", restarted);

    for (const input of [first, second, changed, settled, compacted, afterCompaction, afterRestart, afterRestartAgain]) {
      expect(input.sessionInstruction).toBeUndefined();
      expect(input.systemInstruction).toBeUndefined();
    }
    expect(first.prompt).toContain(`${INSTRUCTIONS_HEADER}\n[build-mode]\n`);
    expect(first.prompt).toContain(`[inertia-orchestration]\nORCHESTRATION_PACK_TEXT\n[inertia-frontend-workbench]\nFRONTEND_PACK_TEXT\n[inertia-chat]\nThis chat's id is ${runtime.conversationId}.`);
    expect(second.prompt).toBe("two");
    expect(changed.prompt).toContain("FRONTEND_PACK_TEXT_V2");
    expect(changed.prompt).toContain("ORCHESTRATION_PACK_TEXT");
    expect(changed.prompt).not.toContain("[build-mode]");
    expect(settled.prompt).toBe("four");
    expect(compacted.prompt).toContain("FRONTEND_PACK_TEXT_V2");
    expect(compacted.prompt).toContain("[build-mode]");
    expect(afterCompaction.prompt).toBe("six");
    expect(afterRestart.prompt).toContain("FRONTEND_PACK_TEXT_V2");
    expect(afterRestart.prompt).not.toContain("[build-mode]");
    expect(afterRestartAgain.prompt).toBe("eight");
    runtime.store.close();
  });

  it("sends the Build-mode instruction on a session's first turn and on a Plan to Build change only", async () => {
    const { runtime } = await chatRuntime("cursor", () => [], "plan");

    const planned = await runTurn(runtime, "plan it");
    runtime.store.updateConversation(runtime.conversationId, { interactionMode: "build" });
    const switched = await runTurn(runtime, "build it");
    const continued = await runTurn(runtime, "keep going");

    expect(planned.prompt).toBe("plan it");
    expect(switched.sessionId).toBe("session-1");
    expect(switched.prompt).toContain(`${INSTRUCTIONS_HEADER}\n[build-mode]\n`);
    expect(continued.prompt).toBe("keep going");
    runtime.store.close();
  });

  it("falls back to the prompt for a Codex thread that started without system instructions", async () => {
    let pack: readonly HiddenProviderInstruction[] = [];
    const { runtime } = await chatRuntime("codex", () => pack);

    const started = await runTurn(runtime, "one");
    pack = PACK;
    const fallback = await runTurn(runtime, "two");
    const settled = await runTurn(runtime, "three");

    expect(started.sessionInstruction).toBeUndefined();
    expect(fallback.sessionId).toBe("session-1");
    expect(fallback.sessionInstruction).toBe(sessionText(runtime.conversationId));
    expect(fallback.prompt).toBe(`two\n\n${INSTRUCTIONS_HEADER}\n${sessionText(runtime.conversationId).replaceAll("\n\n[", "\n[")}`);
    expect(settled.prompt).toBe("three");
    runtime.store.close();
  });

  it("keeps a Codex thread that started with system instructions on the system channel", async () => {
    const { runtime } = await chatRuntime("codex");

    const first = await runTurn(runtime, "one");
    const second = await runTurn(runtime, "two");

    expect(first.sessionInstruction).toBe(sessionText(runtime.conversationId));
    expect(first.prompt).not.toContain("ORCHESTRATION_PACK_TEXT");
    expect(second.sessionInstruction).toBe(first.sessionInstruction);
    expect(second.prompt).toBe("two");
    runtime.store.close();
  });

  it("adds no instruction header when nothing is due", async () => {
    const { runtime } = await chatRuntime("cursor", () => [], "plan");

    const input = await runTurn(runtime, "just this");

    expect(input.prompt).toBe("just this");
    expect(runtime.store.turnExecutionManifest(runtime.store.latestAgentTurnForConversation(runtime.conversationId)!.id))
      .toMatchObject({ internalInstructionCount: 0, executionSegmentCount: 1 });
    runtime.store.close();
  });
});
