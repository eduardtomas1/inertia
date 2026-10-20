import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand, Conversation } from "../../src/shared/contracts";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING } from "../../src/shared/watcher";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ProviderEvent } from "../../src/server/provider/contracts";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import type {
  ReadOnlyWatcherViolation,
  TurnControllerHooks,
} from "../../src/server/runtime/turns/turn-controller-types";
import { READ_ONLY_WATCHER_STOP_MESSAGE } from "../../src/server/runtime/turns/turn-read-only-watcher";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const now = () => new Date().toISOString();

async function watcherRuntime(
  options: { modelSelection?: Conversation["modelSelection"] } = {},
  hooks: Partial<TurnControllerHooks> = {},
) {
  const violations: ReadOnlyWatcherViolation[] = [];
  const checkpoints: string[] = [];
  const gitBefore: string[] = [];
  const runtime = await createTurnControllerTestRuntime({
    onReadOnlyViolation: (_turn, violation) => { violations.push(violation); },
    createTurnCheckpoint: async (turn) => {
      checkpoints.push(turn.id);
      return { checkpointId: null, failure: null };
    },
    captureGitBefore: ({ turn }) => { gitBefore.push(turn.id); },
    ...hooks,
  });
  const { store } = runtime;
  const watched = store.conversation(runtime.conversationId);
  const { link, conversation: watcher } = store.watcherLinks.createWithConversation({
    link: {
      id: randomUUID(),
      watchedConversationId: watched.id,
      preset: "reviewer",
      instructions: "",
      sharing: { ...DEFAULT_WATCHER_SHARING },
      budgets: { ...DEFAULT_WATCHER_BUDGETS },
      privateConnect: "inherit",
    },
    conversation: {
      projectId: watched.projectId,
      title: "Watcher · Reviewer · Turn conversation",
      options: {
        modelSelection: options.modelSelection
          ?? providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
        interactionMode: "plan",
        accessMode: "supervised",
      },
    },
  }, now());
  const startWake = () => {
    expect(store.watcherLinks.transition(link.id, ["watching"], { status: "waking" }, now())).not.toBeNull();
    const wake = store.watcherLinks.createWake({
      id: randomUUID(),
      linkId: link.id,
      watchedTurnId: null,
      trigger: "manual",
      eventsCovered: 0,
      itemsTruncated: 0,
      itemsOmitted: 0,
      digestBytes: 32,
    }, now())!;
    expect(wake).not.toBeNull();
    const queued = runtime.controller.queue({
      conversationId: watcher.id,
      content: "Check 1 for 'Turn conversation'.",
      authorizedWatcherWakeId: wake.id,
      activateConversation: false,
      turnCheckpoint: true,
    });
    runtime.controller.start(queued.turn.id);
    return { wake, turn: queued.turn };
  };
  return { ...runtime, link, watcher, startWake, violations, checkpoints, gitBefore };
}

function identity(runtime: TurnControllerTestRuntime, conversationId: string) {
  const input = runtime.provider.input!;
  return { providerId: input.providerId, conversationId, runId: input.runId, turnId: input.turnId } as const;
}

function approval(requestId: string, kind: "command" | "file-change" = "command", decisions = ["approve", "deny"] as const) {
  return {
    requestId,
    kind,
    title: kind === "command" ? "Run npm test" : "Edit src/export.ts",
    permissionRoots: [],
    availableDecisions: [...decisions],
  } satisfies Extract<ProviderEvent, { type: "approval" }>["request"];
}

describe("read-only watcher turns", () => {
  it("runs in plan mode with supervised access and only on its claimed check", async () => {
    const runtime = await watcherRuntime();
    try {
      expect(() => runtime.controller.queue({
        conversationId: runtime.watcher.id,
        content: "Forged check",
        authorizedWatcherWakeId: randomUUID(),
      })).toThrow("no longer waiting to start");
      const { turn, wake } = runtime.startWake();
      expect(runtime.provider.input).toMatchObject({ interactionMode: "plan", access: "supervised" });
      expect(runtime.store.watcherLinks.attachWakeTurn(wake.id, turn.id, now())).toBe(true);
    } finally {
      runtime.store.close();
    }
  });

  it("declines an approval without a card and stops at the second request", async () => {
    const runtime = await watcherRuntime();
    try {
      const respond = vi.spyOn(runtime.provider, "respondToApproval");
      const { turn } = runtime.startWake();
      const base = identity(runtime, runtime.watcher.id);
      runtime.provider.emit({ ...base, type: "approval", request: approval("approval-1") });

      expect(respond).toHaveBeenCalledWith(runtime.watcher.id, "approval-1", "deny", { runId: turn.runId, turnId: turn.id });
      expect(runtime.events.some((event) => event.type === "agent.approval.requested")).toBe(false);
      expect(runtime.store.conversation(runtime.watcher.id)).toMatchObject({ status: "running", attentionKind: null });
      expect(runtime.store.agentTurn(turn.id).status).not.toBe("failed");
      expect(runtime.store.conversationDetail(runtime.watcher.id)!.activities.map(({ title }) => title))
        .toContain("Needed permission: Run npm test — declined (watchers are read-only)");
      expect(runtime.violations).toEqual([expect.objectContaining({ kind: "command-attempt", stopped: false })]);

      runtime.provider.emit({ ...base, type: "approval-resolved", requestId: "approval-1", decision: "deny" });
      expect(runtime.events.some((event) => event.type === "agent.approval.resolved")).toBe(false);

      runtime.provider.emit({ ...base, type: "approval", request: approval("approval-2", "file-change") });
      await flushTurnControllerTestPromises();
      expect(respond).toHaveBeenCalledTimes(2);
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "failed", terminalReason: "unsupported-interaction" });
      expect(runtime.provider.cancelCount).toBeGreaterThan(0);
      expect(runtime.violations.at(-1)).toMatchObject({ kind: "approval-limit", stopped: true, linkId: runtime.link.id });
    } finally {
      runtime.store.close();
    }
  });

  it("stops when an approval cannot be declined", async () => {
    const runtime = await watcherRuntime();
    try {
      const { turn } = runtime.startWake();
      runtime.provider.emit({
        ...identity(runtime, runtime.watcher.id),
        type: "approval",
        request: approval("approval-1", "file-change", ["approve"] as never),
      });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "failed", terminalReason: "unsupported-interaction" });
      expect(runtime.violations).toEqual([expect.objectContaining({ kind: "write-attempt", stopped: true })]);
    } finally {
      runtime.store.close();
    }
  });

  it("stops on a question instead of asking the user", async () => {
    const runtime = await watcherRuntime();
    try {
      const { turn } = runtime.startWake();
      runtime.provider.emit({
        ...identity(runtime, runtime.watcher.id),
        type: "input",
        request: {
          requestId: "input-1",
          questions: [{ id: "q", header: "Scope", question: "Which file?", options: [], allowMultiple: false, isOther: false }],
        },
      } as ProviderEvent);
      await flushTurnControllerTestPromises();
      expect(runtime.events.some((event) => event.type === "agent.input.requested")).toBe(false);
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "failed", terminalReason: "unsupported-interaction" });
      expect(runtime.violations).toEqual([expect.objectContaining({ kind: "input", detail: "Which file?", stopped: true })]);
    } finally {
      runtime.store.close();
    }
  });

  it.each([
    ["a file change", "File change"],
    ["an edit tool", "Edit"],
    ["a write tool", "Write"],
  ])("stops on %s as soon as it starts", async (_name, label) => {
    const runtime = await watcherRuntime();
    try {
      const { turn } = runtime.startWake();
      runtime.provider.emit({ ...identity(runtime, runtime.watcher.id), type: "activity", kind: "tool", phase: "started", label });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id)).toMatchObject({ status: "failed", terminalReason: "unsupported-interaction" });
      expect(runtime.store.conversationDetail(runtime.watcher.id)!.messages.map(({ content }) => content).join("\n"))
        .toContain(READ_ONLY_WATCHER_STOP_MESSAGE);
      expect(runtime.violations).toEqual([expect.objectContaining({ kind: "write-attempt", detail: label, stopped: true })]);
    } finally {
      runtime.store.close();
    }
  });

  it("lets read-only commands and reads run", async () => {
    const runtime = await watcherRuntime();
    try {
      const { turn } = runtime.startWake();
      const base = identity(runtime, runtime.watcher.id);
      runtime.provider.emit({ ...base, type: "activity", kind: "command", phase: "started", label: "rg TODO src", activityId: "c1" });
      runtime.provider.emit({ ...base, type: "activity", kind: "command", phase: "completed", label: "rg TODO src", activityId: "c1" });
      runtime.provider.emit({ ...base, type: "activity", kind: "tool", phase: "started", label: "Read src/export.ts", activityId: "t1" });
      runtime.provider.resolve({ status: "completed", text: "SILENT" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
      expect(runtime.violations).toEqual([]);
    } finally {
      runtime.store.close();
    }
  });

  it("never checkpoints or captures Git artifacts for a watcher turn", async () => {
    const runtime = await watcherRuntime();
    try {
      const { turn } = runtime.startWake();
      runtime.provider.resolve({ status: "completed", text: "SILENT" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(turn.id).status).toBe("completed");
      expect(runtime.checkpoints).toEqual([]);
      expect(runtime.gitBefore).toEqual([]);
      expect(runtime.gitArtifacts).not.toContain(turn.id);

      const ordinary = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Real work", turnCheckpoint: true });
      runtime.controller.start(ordinary.turn.id);
      await flushTurnControllerTestPromises();
      expect(runtime.checkpoints).toEqual([ordinary.turn.id]);
    } finally {
      runtime.store.close();
    }
  });

  it.each([
    ["build mode", { interactionMode: "build" as const }],
    ["auto-edit access", { accessMode: "auto-edit" as const }],
    ["full access", { accessMode: "full" as const }],
  ])("refuses to prepare a watcher turn in %s", async (_name, patch) => {
    const runtime = await watcherRuntime();
    try {
      runtime.store.updateConversation(runtime.watcher.id, patch);
      expect(() => runtime.controller.queue({ conversationId: runtime.watcher.id, content: "Typed by the user" }))
        .toThrow("A watcher stays read-only: plan mode with supervised access.");
      expect(runtime.provider.runCount).toBe(0);
    } finally {
      runtime.store.close();
    }
  });

  it("refuses to prepare a watcher turn on a harness outside the reviewed list", async () => {
    const runtime = await watcherRuntime({
      modelSelection: {
        ...providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
        harnessId: "codex-cli",
      },
    });
    try {
      expect(() => runtime.controller.queue({ conversationId: runtime.watcher.id, content: "Typed by the user" }))
        .toThrow("This agent cannot run as a read-only watcher.");
    } finally {
      runtime.store.close();
    }
  });

  it("guards messages the user types into the watcher once it is detached no longer", async () => {
    const runtime = await watcherRuntime();
    try {
      runtime.store.watcherLinks.transition(runtime.link.id, ["watching"], { status: "detached", reason: "user" }, now());
      runtime.store.updateConversation(runtime.watcher.id, { interactionMode: "build" });
      const queued = runtime.controller.queue({ conversationId: runtime.watcher.id, content: "Now a normal chat", turnCheckpoint: true });
      runtime.controller.start(queued.turn.id);
      await flushTurnControllerTestPromises();
      expect(runtime.provider.input).toMatchObject({ interactionMode: "build" });
      expect(runtime.checkpoints).toEqual([queued.turn.id]);
    } finally {
      runtime.store.close();
    }
  });
});

describe("watcher run configuration updates", () => {
  const update = (conversationId: string, payload: Record<string, unknown>) => ({
    type: "conversation.update",
    requestId: randomUUID(),
    payload: { conversationId, ...payload },
  }) as Extract<ClientCommand, { type: "conversation.update" }>;

  it("refuses mode and access changes while attached", async () => {
    const runtime = await watcherRuntime();
    try {
      const handler = createConversationCommandHandler({
        store: runtime.store,
        backendProfileController: { isExternalSelection: vi.fn(() => false) },
      } as unknown as ConversationCommandDependencies);
      for (const payload of [{ interactionMode: "build" }, { accessMode: "full" }, { accessMode: "auto-edit" }]) {
        await expect(handler({} as never, update(runtime.watcher.id, payload)))
          .rejects.toThrow("A watcher stays read-only");
      }
      expect(runtime.store.conversation(runtime.watcher.id)).toMatchObject({ interactionMode: "plan", accessMode: "supervised" });
      await expect(handler({} as never, update(runtime.watcher.id, { interactionMode: "plan" }))).resolves.toBe("mutation");
      await expect(handler({} as never, update(runtime.conversationId, { interactionMode: "plan" }))).resolves.toBe("mutation");

      runtime.store.watcherLinks.transition(runtime.link.id, ["watching"], { status: "detached", reason: "user" }, now());
      await expect(handler({} as never, update(runtime.watcher.id, { interactionMode: "build" }))).resolves.toBe("mutation");
    } finally {
      runtime.store.close();
    }
  });
});
