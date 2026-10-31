import { afterEach, describe, expect, it } from "vitest";

import type { ProviderId } from "../../src/shared/contracts";
import {
  providerNativeHarnessId,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import { FULL_HARNESS_CAPABILITY_OFFER } from "../../src/server/runtime/harness-capabilities";
import {
  BUILD_MODE_INSTRUCTION,
  type HiddenProviderInstruction,
} from "../../src/server/runtime/turns/request-context";
import {
  MAX_TRACKED_PROMPT_DELIVERIES,
  PromptInstructionDeliveries,
  sessionInstructionDigest,
} from "../../src/server/runtime/turns/turn-instruction-delivery";
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
    capabilityOfferForTurn: () => ({ instructions: pack(), offer: FULL_HARNESS_CAPABILITY_OFFER }),
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
  options: { goalStart?: { objective: string }; compactionActivity?: string } = {},
): Promise<ProviderRunInput> {
  const queued = controller.queue({
    conversationId: runtime.conversationId,
    content,
    ...(options.goalStart ? { goalStart: options.goalStart } : {}),
  });
  expect(controller.start(queued.turn.id)).toBe(true);
  const input = runtime.provider.input!;
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  if (options.compactionActivity) {
    runtime.provider.emit({
      ...turnControllerTestIdentity(runtime),
      type: "activity",
      kind: "system",
      phase: "completed",
      label: options.compactionActivity,
      activityId: "compaction-1",
    });
  }
  runtime.provider.resolve({ status: "completed", sessionId });
  await flushTurnControllerTestPromises();
  expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
  return input;
}

function compact(
  runtime: TurnControllerTestRuntime,
  providerId: ProviderId,
  clock: () => Date,
  sentInstruction?: string,
): void {
  runtime.store.createMessage(runtime.conversationId, "/compact", "system", [], null, clock().toISOString(), {
    compaction: {
      providerId,
      beforeTokens: 100,
      afterTokens: 10,
      instructionForwarded: false,
      sessionInstructionDigest: sentInstruction === undefined ? null : sessionInstructionDigest(sentInstruction),
    },
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

  it("sends Build mode after a Codex native goal start, which sends no prompt", async () => {
    const { runtime } = await chatRuntime("codex");

    const goal = await runTurn(runtime, "/goal ship it", "session-1", runtime.controller, { goalStart: { objective: "ship it" } });
    const next = await runTurn(runtime, "now do this");
    const after = await runTurn(runtime, "and this");

    expect(goal.goalStart).toBeDefined();
    expect(runtime.store.agentGoals(runtime.conversationId)).toEqual([]);
    expect(next.sessionId).toBe("session-1");
    expect(next.prompt).toContain("[build-mode]");
    expect(after.prompt).toBe("and this");
    runtime.store.close();
  });

  it("re-sends a Codex chat's pack when its text changes at the same size", async () => {
    let pack: readonly HiddenProviderInstruction[] = PACK;
    const { runtime } = await chatRuntime("codex", () => pack);

    const first = await runTurn(runtime, "one");
    pack = [PACK[0]!, { label: "inertia-frontend-workbench", text: "FRONTEND_PACK_TEXZ" }];
    expect(Buffer.byteLength(pack[1]!.text)).toBe(Buffer.byteLength(PACK[1]!.text));
    expect(pack[1]!.text).not.toBe(PACK[1]!.text);
    const second = await runTurn(runtime, "two");
    const third = await runTurn(runtime, "three");

    expect(first.prompt).toBe(`one\n\n${INSTRUCTIONS_HEADER}\n[build-mode]\n${BUILD_MODE_INSTRUCTION}`);
    expect(second.sessionInstruction).toBe(sessionText(runtime.conversationId, pack));
    expect(second.prompt).toContain(`[inertia-frontend-workbench]\n${pack[1]!.text}`);
    expect(third.prompt).toBe("three");
    runtime.store.close();
  });

  it("re-sends a Codex chat's pack and Build mode after a compaction receipt", async () => {
    const { runtime, clock } = await chatRuntime("codex");

    await runTurn(runtime, "one");
    compact(runtime, "codex", clock);
    const after = await runTurn(runtime, "two");
    const settled = await runTurn(runtime, "three");

    expect(after.sessionId).toBe("session-1");
    expect(after.prompt).toContain("[build-mode]");
    expect(after.prompt).toContain("ORCHESTRATION_PACK_TEXT");
    expect(settled.prompt).toBe("three");
    runtime.store.close();
  });

  it.each([
    ["codex", "Context compaction"],
    ["cursor", "Cursor compacted session context"],
    ["kimi", "Kimi Code compacted session context"],
  ] as const)("re-sends after a %s compaction recorded only as an activity", async (providerId, label) => {
    const { runtime } = await chatRuntime(providerId);

    await runTurn(runtime, "one", "session-1", runtime.controller, { compactionActivity: label });
    const after = await runTurn(runtime, "two");
    const settled = await runTurn(runtime, "three");

    expect(after.prompt).toContain("[build-mode]");
    expect(after.prompt).toContain("ORCHESTRATION_PACK_TEXT");
    expect(settled.prompt).toBe("three");
    runtime.store.close();
  });

  it("keeps a Claude session's pack at system level after a compaction, including after a restart", async () => {
    const { runtime, hooks, clock } = await chatRuntime("claude");

    await runTurn(runtime, "one", "session-1", runtime.controller, { compactionActivity: "Claude compacted context" });
    const after = await runTurn(runtime, "two");
    const settled = await runTurn(runtime, "three");
    compact(runtime, "claude", clock, sessionText(runtime.conversationId));
    const afterReceipt = await runTurn(runtime, "four");
    let restartIds = 0;
    const restarted = new TurnController(runtime.store, runtime.provider, new Map(), new Map(), new Map(), hooks, {
      scheduler: new FakeTurnScheduler(),
      clock,
      id: () => `restarted-id-${++restartIds}`,
    });
    const afterRestart = await runTurn(runtime, "five", "session-1", restarted);

    expect(after.prompt).toBe(`two\n\n${INSTRUCTIONS_HEADER}\n[build-mode]\n${BUILD_MODE_INSTRUCTION}`);
    expect(after.sessionInstruction).toBe(sessionText(runtime.conversationId));
    expect(settled.prompt).toBe("three");
    expect(afterReceipt.prompt).toBe(`four\n\n${INSTRUCTIONS_HEADER}\n[build-mode]\n${BUILD_MODE_INSTRUCTION}`);
    expect(afterRestart.prompt).toBe("five");
    runtime.store.close();
  });

  it("re-sends a Claude session's pack after a compaction that ran without it", async () => {
    const { runtime, clock } = await chatRuntime("claude");

    await runTurn(runtime, "one");
    const settled = await runTurn(runtime, "two");
    compact(runtime, "claude", clock);
    const afterUnattested = await runTurn(runtime, "three");

    expect(settled.prompt).toBe("two");
    expect(afterUnattested.prompt).toContain("ORCHESTRATION_PACK_TEXT");
    expect(afterUnattested.sessionInstruction).toBe(sessionText(runtime.conversationId));
    runtime.store.close();
  });

  it("re-sends a Claude session's pack after a compaction that ran with other pack text", async () => {
    let pack: readonly HiddenProviderInstruction[] = PACK;
    const { runtime } = await chatRuntime("claude", () => pack);

    await runTurn(runtime, "one");
    pack = [PACK[0]!, { label: "inertia-frontend-workbench", text: "FRONTEND_PACK_TEXT_V2" }];
    const changed = await runTurn(runtime, "two");
    pack = PACK;
    await runTurn(runtime, "three", "session-1", runtime.controller, { compactionActivity: "Claude compacted context" });
    pack = [PACK[0]!, { label: "inertia-frontend-workbench", text: "FRONTEND_PACK_TEXT_V2" }];
    const afterCompaction = await runTurn(runtime, "four");

    expect(changed.prompt).toContain("FRONTEND_PACK_TEXT_V2");
    expect(afterCompaction.prompt).toContain("FRONTEND_PACK_TEXT_V2");
    runtime.store.close();
  });

  it("forgets a chat's prompt delivery when asked, so the next turn re-sends the pack", async () => {
    const { runtime } = await chatRuntime("cursor");

    await runTurn(runtime, "one");
    runtime.controller.forgetPromptDelivery(runtime.conversationId);
    const after = await runTurn(runtime, "two");

    expect(after.prompt).toContain("ORCHESTRATION_PACK_TEXT");
    runtime.store.close();
  });

  it("gives compaction the same session instruction as a turn, only where the harness keeps one", async () => {
    const claude = await chatRuntime("claude");
    const cursor = await chatRuntime("cursor");
    const instruction = (runtime: TurnControllerTestRuntime) => {
      const conversation = runtime.store.conversation(runtime.conversationId);
      return runtime.controller.compactionSessionInstruction(
        conversation,
        runtime.provider.resolveModelRoute(conversation.modelSelection),
      );
    };

    const turn = await runTurn(claude.runtime, "one");

    expect(instruction(claude.runtime)).toBe(turn.sessionInstruction);
    expect(instruction(cursor.runtime)).toBeUndefined();
    claude.runtime.store.close();
    cursor.runtime.store.close();
  });

  it("sends Build mode on the next turn after a Claude session is replaced mid-turn", async () => {
    const { runtime } = await chatRuntime("claude");

    await runTurn(runtime, "one");
    const reset = await runTurn(runtime, "/clear", "session-2");
    const next = await runTurn(runtime, "now build", "session-2");

    expect(reset.sessionId).toBe("session-1");
    expect(runtime.store.agentTurnsForConversation(runtime.conversationId).at(-2))
      .toMatchObject({ providerSessionBefore: "session-1", providerSessionAfter: "session-2" });
    expect(next.sessionId).toBe("session-2");
    expect(next.prompt).toContain("[build-mode]");
    runtime.store.close();
  });

  it("sends an OpenCode chat's pack in the prompt once, never as system text", async () => {
    const { runtime } = await chatRuntime("opencode");

    const first = await runTurn(runtime, "one");
    const second = await runTurn(runtime, "two");

    expect(first.sessionInstruction).toBeUndefined();
    expect(first.systemInstruction).toBeUndefined();
    expect(first.prompt).toContain(`[inertia-chat]\nThis chat's id is ${runtime.conversationId}.`);
    expect(second.sessionInstruction).toBeUndefined();
    expect(second.prompt).toBe("two");
    runtime.store.close();
  });

  it("keeps a chat whose delivery was just read when it must forget one", () => {
    const deliveries = new PromptInstructionDeliveries();
    for (let index = 0; index < MAX_TRACKED_PROMPT_DELIVERIES; index += 1) {
      deliveries.record(`chat-${index}`, `turn-${index}`, "digest");
    }
    expect(deliveries.sentTurnId("chat-0", "digest")).toBe("turn-0");
    deliveries.record("chat-new", "turn-new", "digest");

    expect(deliveries.sentTurnId("chat-0", "digest")).toBe("turn-0");
    expect(deliveries.sentTurnId("chat-1", "digest")).toBeNull();
  });

  it("forgets the oldest chats once it tracks too many prompt deliveries", () => {
    const deliveries = new PromptInstructionDeliveries();
    for (let index = 0; index <= MAX_TRACKED_PROMPT_DELIVERIES; index += 1) {
      deliveries.record(`chat-${index}`, `turn-${index}`, "digest");
    }
    deliveries.record("chat-1", "turn-1b", "digest");
    deliveries.record("chat-new", "turn-new", "digest");

    expect(deliveries.sentTurnId("chat-0", "digest")).toBeNull();
    expect(deliveries.sentTurnId("chat-1", "digest")).toBe("turn-1b");
    expect(deliveries.sentTurnId("chat-2", "digest")).toBeNull();
    expect(deliveries.sentTurnId(`chat-${MAX_TRACKED_PROMPT_DELIVERIES}`, "digest")).toBe(`turn-${MAX_TRACKED_PROMPT_DELIVERIES}`);
    expect(deliveries.sentTurnId("chat-new", "digest")).toBe("turn-new");
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
