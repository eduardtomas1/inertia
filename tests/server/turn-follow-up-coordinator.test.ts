import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { RuntimeStore } from "../../src/server/database";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import type { ActiveTurn } from "../../src/server/runtime/turns/turn-controller-types";
import { TurnFollowUpCoordinator } from "../../src/server/runtime/turns/turn-follow-up-coordinator";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  type TurnControllerTestRuntime,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function activeTurn(transport: "starting" | "running" = "running"): ActiveTurn {
  const runState = new AuthoritativeRunStateEngine({
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "codex",
  });
  runState.setTransport(transport);
  return {
    conversation: { id: "conversation-1" },
    turn: {
      id: "turn-1",
      runId: "run-1",
      harnessId: "codex-app-server",
    },
    runState,
    supportsFollowUpImages: true,
    followUpAdmissions: new Set<Promise<void>>(),
    followUpAdmissionTail: Promise.resolve(),
  } as unknown as ActiveTurn;
}

describe("TurnFollowUpCoordinator", () => {
  it("includes trusted snapshot context only in the provider follow-up", async () => {
    const active = activeTurn();
    const steer = vi.fn(async () => true);
    const persist = vi.fn(() => ({ content: "Inspect this window" }) as ChatMessage);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: { createAcknowledgedFollowUpMessage: persist } as unknown as RuntimeStore,
      now: () => "2026-09-08T09:00:00.000Z", activeForConversation: () => active,
    });
    const lease = coordinator.acquire(active)!;
    const attachments = [{ id: "11111111-1111-4111-8111-111111111111", name: "snapshot.png", path: "/trusted/snapshot.png", mimeType: "image/png" as const, size: 4, snapshot: snapshotFixture() }];
    try {
      await coordinator.steer(lease, { content: "Inspect this window", imagePaths: [attachments[0]!.path] }, attachments);
      expect(steer).toHaveBeenCalledWith("conversation-1", expect.objectContaining({ content: expect.stringContaining("untrusted captured application content") }), { runId: "run-1", turnId: "turn-1" });
      expect(persist).toHaveBeenCalledWith("conversation-1", "turn-1", "Inspect this window", lease.submittedAt, "2026-09-08T09:00:00.000Z", attachments);
    } finally { lease.release(); }
  });

  it("serializes acknowledged parent follow-ups FIFO for the exact active turn", async () => {
    const active = activeTurn();
    const acknowledgements: Array<(accepted: boolean) => void> = [];
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      acknowledgements.push(resolve);
    }));
    const persist = vi.fn((
      _conversationId: string,
      turnId: string,
      content: string,
      _submittedAt?: string,
    ) => ({ turnId, content }) as ChatMessage);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: {
        createAcknowledgedFollowUpMessage: persist,
      } as unknown as RuntimeStore,
      now: () => "2026-08-18T00:00:00.000Z",
      activeForConversation: () => active,
    });
    const firstAdmission = coordinator.acquire(active)!;
    const secondAdmission = coordinator.acquire(active)!;
    const first = coordinator.steer(firstAdmission, {
      content: "First follow-up",
      imagePaths: [],
    }, []);
    const second = coordinator.steer(secondAdmission, {
      content: "Second follow-up",
      imagePaths: [],
    }, []);

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    acknowledgements[0]!(true);
    await expect(first).resolves.toMatchObject({ kind: "accepted", message: { content: "First follow-up" } });
    firstAdmission.release();
    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(2);
    acknowledgements[1]!(true);
    await expect(second).resolves.toMatchObject({ kind: "accepted", message: { content: "Second follow-up" } });
    secondAdmission.release();
    expect(persist.mock.calls.map(([, , content]) => content)).toEqual([
      "First follow-up",
      "Second follow-up",
    ]);
    expect(persist.mock.calls.map(([, , , submittedAt]) => submittedAt))
      .toEqual([
        "2026-08-18T00:00:00.000Z",
        "2026-08-18T00:00:00.001Z",
      ]);
  });

  it("delivers a follow-up admitted while the provider turn is starting once it runs", async () => {
    const active = activeTurn("starting");
    const steer = vi.fn(async () => active.runState.snapshot().state === "running");
    const persist = vi.fn((
      _conversationId: string,
      turnId: string,
      content: string,
    ) => ({ turnId, content }) as ChatMessage);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: { createAcknowledgedFollowUpMessage: persist } as unknown as RuntimeStore,
      now: () => "2026-09-30T09:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const pending = coordinator.steer(admission, {
      content: "Steer with this image.",
      imagePaths: ["/trusted/steer.png"],
    }, []);

    await flushPromises();
    expect(steer).not.toHaveBeenCalled();
    active.runState.setTransport("running");

    await expect(pending).resolves.toMatchObject({ kind: "accepted", message: {
      turnId: "turn-1",
      content: "Steer with this image.",
    } });
    expect(steer).toHaveBeenCalledOnce();
    admission.release();
  });

  it.each(["abort", "cancel"] as const)("stops waiting for a starting provider turn on %s", async (ending) => {
    const active = activeTurn("starting");
    const steer = vi.fn(async () => true);
    const coordinator = new TurnFollowUpCoordinator({
      providers: { steer } as unknown as TurnProviderRuntime,
      store: { createAcknowledgedFollowUpMessage: vi.fn() } as unknown as RuntimeStore,
      now: () => "2026-09-30T09:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const controller = new AbortController();
    const pending = coordinator.steer(
      admission,
      { content: "Never reaches a started turn", imagePaths: [] },
      [],
      undefined,
      controller.signal,
    );

    await flushPromises();
    if (ending === "abort") controller.abort();
    else active.runState.requestTerminal("cancelled", "test-cancelled");

    await expect(pending).resolves.toEqual({ kind: ending === "abort" ? "unavailable" : "turn-ended" });
    expect(steer).not.toHaveBeenCalled();
    admission.release();
  });

  it("does not dispatch a queued follow-up after its owner is cancelled", async () => {
    const steer = vi.fn(async () => true);
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: vi.fn(),
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const blocker = coordinator.acquire(active);
    const cancelled = coordinator.acquire(active);
    expect(blocker).not.toBeNull();
    expect(cancelled).not.toBeNull();
    const controller = new AbortController();
    const pending = coordinator.steer(
      cancelled!,
      { content: "Do not dispatch this cancelled follow-up", imagePaths: [] },
      [],
      undefined,
      controller.signal,
    );

    controller.abort();
    blocker!.release();

    await expect(pending).resolves.toEqual({ kind: "unavailable" });
    expect(steer).not.toHaveBeenCalled();
    cancelled!.release();
  });

  it("persists provider-accepted work when the caller aborts during admission", async () => {
    let accept!: (accepted: boolean) => void;
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      accept = resolve;
    }));
    const persist = vi.fn((
      _conversationId: string,
      turnId: string,
      content: string,
    ) => ({ turnId, content }) as ChatMessage);
    const acknowledged = vi.fn();
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: persist,
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const controller = new AbortController();
    const pending = coordinator.steer(
      admission,
      { content: "Keep the provider-accepted follow-up", imagePaths: [] },
      [],
      acknowledged,
      controller.signal,
    );

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    controller.abort();
    accept(true);

    await expect(pending).resolves.toMatchObject({ kind: "accepted", message: {
      turnId: active.turn.id,
      content: "Keep the provider-accepted follow-up",
    } });
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    admission.release();
  });

  it.each([
    [true, "completed", "accepted"],
    [true, "cancelled", "unconfirmed"],
    [true, "failed", "unconfirmed"],
    [false, "cancelled", "refused"],
  ] as const)("settles a follow-up acknowledged %s as its owner ends %s as %s", async (accepted, ending, kind) => {
    let accept!: (accepted: boolean) => void;
    const steer = vi.fn(async () => await new Promise<boolean>((resolve) => {
      accept = resolve;
    }));
    const persist = vi.fn(() => ({ content: "Sent while the turn ended" }) as ChatMessage);
    const acknowledged = vi.fn();
    const active = activeTurn();
    const coordinator = new TurnFollowUpCoordinator({
      store: {
        createAcknowledgedFollowUpMessage: persist,
        agentTurn: () => ({ status: "running" }),
      } as never,
      providers: { steer } as never,
      now: () => "2026-08-21T10:00:00.000Z",
      activeForConversation: () => active,
    });
    const admission = coordinator.acquire(active)!;
    const pending = coordinator.steer(
      admission,
      { content: "Sent while the turn ended", imagePaths: [] },
      [],
      acknowledged,
    );

    await flushPromises();
    expect(steer).toHaveBeenCalledTimes(1);
    active.runState.requestTerminal(ending, "test-ended");
    accept(accepted);

    await expect(pending).resolves.toMatchObject({ kind });
    expect(acknowledged).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (kind === "accepted") {
      expect(persist).toHaveBeenCalledExactlyOnceWith("conversation-1", "turn-1", "Sent while the turn ended", admission.submittedAt, "2026-08-21T10:00:00.000Z", []);
    } else {
      expect(persist).not.toHaveBeenCalled();
    }
    admission.release();
  });
});

describe("assistant rows around an accepted follow-up", () => {
  afterEach(cleanupTurnControllerTestDirectories);

  const flushStreams = (runtime: TurnControllerTestRuntime): void => {
    for (const [id, callback] of runtime.scheduler.callbacks) {
      if ((runtime.scheduler.delays.get(id) ?? 0) >= 1_000) continue;
      runtime.scheduler.callbacks.delete(id);
      runtime.scheduler.delays.delete(id);
      callback();
    }
  };
  const running = async (claude = false) => {
    const runtime = await createTurnControllerTestRuntime({}, claude
      ? { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) }
      : {});
    const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First task" });
    runtime.controller.start(queued.turn.id);
    runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
    return { runtime, turnId: queued.turn.id };
  };
  const followUp = async (runtime: TurnControllerTestRuntime, content: string) => {
    const lease = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
    try {
      return await runtime.controller.steer(lease, { content, imagePaths: [] });
    } finally { lease.release(); }
  };
  const rows = (runtime: TurnControllerTestRuntime, turnId: string) =>
    runtime.store.conversationDetail(runtime.conversationId)!.messages
      .filter((message) => message.turnId === turnId && message.content !== "First task")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(({ role, content }) => `${role}:${content}`);
  const persistedCommentary = (events: ServerEvent[]) => events.flatMap((event) =>
    event.type === "agent.commentary.persisted" ? [event.message.content] : []);

  it("closes the open answer before it saves the follow-up", async () => {
    const { runtime, turnId } = await running();
    try {
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Answer to the first task." });
      const result = await followUp(runtime, "Also rename the file.");
      expect(result.kind).toBe("accepted");
      expect(persistedCommentary(runtime.events)).toEqual(["Answer to the first task."]);
      const answer = runtime.store.conversationDetail(runtime.conversationId)!.messages
        .find(({ content }) => content === "Answer to the first task.")!;
      const followUpMessage = (result as { message: ChatMessage }).message;
      expect(Date.parse(followUpMessage.createdAt)).toBeGreaterThan(Date.parse(answer.createdAt));
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Renamed it." });
      flushStreams(runtime);
      expect(rows(runtime, turnId)).toEqual([
        "assistant:Answer to the first task.",
        "user:Also rename the file.",
        "assistant:Renamed it.",
      ]);
    } finally {
      runtime.provider.resolve();
      runtime.store.close();
    }
  });

  it.each([
    ["extends", "Answer to the first task.", "Answer to the first task.Renamed it and updated imports.", "Renamed it and updated imports."],
    ["drops a trailing space from", "Answer. ", "Answer.Renamed it.", "Renamed it."],
    ["rewrites", "Answer to the first task.", "Answer to the second task. Renamed it.", "second task. Renamed it."],
  ])("keeps the earlier answer once when a provider snapshot %s the text before a follow-up", async (_case, earlier, snapshot, reply) => {
    const { runtime, turnId } = await running();
    try {
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: earlier });
      const accepted = await followUp(runtime, "Also rename the file.") as { message: ChatMessage };
      runtime.provider.emit({ ...identity, type: "text", text: "Renamed it." });
      flushStreams(runtime);
      runtime.provider.emit({ ...identity, type: "text-snapshot", itemId: "item-1", text: snapshot });
      const expected = [`assistant:${earlier}`, "user:Also rename the file.", `assistant:${reply}`];
      expect(rows(runtime, turnId)).toEqual(expected);
      const replaced = runtime.events.findLast((event) => event.type === "agent.text.replaced");
      expect(replaced).toMatchObject({ message: { content: reply }, after: accepted.message.createdAt });
      runtime.provider.resolve({ text: snapshot });
      await flushTurnControllerTestPromises();
      flushStreams(runtime);
      expect(rows(runtime, turnId)).toEqual(expected);
      expect(runtime.store.agentTurn(turnId).status).toBe("completed");
    } finally {
      runtime.provider.resolve();
      runtime.store.close();
    }
  });

  it("keeps the earlier answer once when the final provider text drops a trailing space before a follow-up", async () => {
    const { runtime, turnId } = await running();
    try {
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "Answer. " });
      await followUp(runtime, "Also rename the file.");
      runtime.provider.emit({ ...identity, type: "text", text: "Renamed it." });
      flushStreams(runtime);
      runtime.provider.resolve({ text: "Answer.Renamed it." });
      await flushTurnControllerTestPromises();
      flushStreams(runtime);
      expect(rows(runtime, turnId)).toEqual(["assistant:Answer. ", "user:Also rename the file.", "assistant:Renamed it."]);
    } finally {
      runtime.provider.resolve();
      runtime.store.close();
    }
  });

  it("keeps a Claude answer written after an empty correction while the follow-up waits for its boundary", async () => {
    const { runtime, turnId } = await running(true);
    try {
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "Draft" });
      await followUp(runtime, "Also rename the file.");
      runtime.provider.emit({ ...identity, type: "text-snapshot", itemId: "retracted", text: "" });
      runtime.provider.emit({ ...identity, type: "text", text: "Fallback answer." });
      flushStreams(runtime);
      runtime.provider.emit({ ...identity, type: "text-boundary" });
      runtime.provider.emit({ ...identity, type: "text", text: "Reply." });
      flushStreams(runtime);
      runtime.provider.emit({ ...identity, type: "text-snapshot", itemId: "corrected", text: "Fallback answer.Reply!" });
      expect(rows(runtime, turnId).join("|")).toContain("Fallback answer.");
      expect(rows(runtime, turnId).slice(0, 2)).toEqual(["assistant:Draft", "user:Also rename the file."]);
    } finally {
      runtime.provider.resolve();
      runtime.store.close();
    }
  });

  it("keeps a Claude answer that is still streaming before the follow-up until Claude ends that answer", async () => {
    const { runtime, turnId } = await running(true);
    try {
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "Answer to the first" });
      await followUp(runtime, "Also rename the file.");
      runtime.provider.emit({ ...identity, type: "text", text: " task." });
      flushStreams(runtime);
      runtime.provider.emit({ ...identity, type: "text-boundary" });
      runtime.provider.emit({ ...identity, type: "text", text: "Renamed it." });
      flushStreams(runtime);
      expect(rows(runtime, turnId)).toEqual([
        "assistant:Answer to the first task.",
        "user:Also rename the file.",
        "assistant:Renamed it.",
      ]);
    } finally {
      runtime.provider.resolve();
      runtime.store.close();
    }
  });
});
