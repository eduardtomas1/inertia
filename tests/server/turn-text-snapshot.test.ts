import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { ProviderEvent } from "../../src/server/provider/contracts";
import {
  TurnProviderEventProjector,
} from "../../src/server/runtime/turns/turn-provider-event-projector";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller-types";
import {
  TurnStreamProjection,
} from "../../src/server/runtime/turns/turn-stream-projection";

const directories: string[] = [];
type ProviderEventInput = {
  [Type in ProviderEvent["type"]]: Omit<
    Extract<ProviderEvent, { type: Type }>,
    "providerId" | "conversationId" | "runId" | "turnId"
  >;
}[ProviderEvent["type"]];

class ManualScheduler implements TurnTimerScheduler {
  private sequence = 0;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    for (const [id, callback] of this.callbacks) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

async function snapshotRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-text-snapshot-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Snapshot projection", workspace);
  const conversation = store.createConversation(project.id, "Correction");
  const user = store.createMessage(conversation.id, "Correct the answer.");
  const createdTurn = store.createAgentTurn({
    id: "snapshot-turn",
    conversationId: conversation.id,
    runId: "snapshot-run",
    userMessageId: user.id,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "legacy:codex:codex-app-server",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  });
  const turn = store.updateAgentTurnLifecycle(createdTurn.id, {
    status: "running",
  });
  const events: Parameters<TurnControllerHooks["broadcast"]>[0][] = [];
  let snapshots = 0;
  const hooks = {
    broadcast: (event) => events.push(event),
    broadcastSnapshot: () => {
      snapshots += 1;
    },
    providerInfo: () => [],
  } satisfies TurnControllerHooks;
  const scheduler = new ManualScheduler();
  const active = {
    turn,
    conversation,
    assistantText: "",
    assistantPendingHighSurrogate: "",
    assistantSegmentText: "",
    assistantMessageId: null,
    latestAssistantMessageId: null,
    reasoningText: "",
    reasoningPendingHighSurrogate: "",
    reasoningId: null,
  } as unknown as ActiveTurn;
  const streams = new TurnStreamProjection({
    store,
    hooks,
    scheduler,
    now: () => "2030-01-01T00:00:00.000Z",
    onPersistenceFailure: (_active, error) => {
      throw error;
    },
  });
  active.assistantStream = streams.create(() => active, "assistant");
  active.reasoningStream = streams.create(() => active, "reasoning");
  const projector = new TurnProviderEventProjector({
    store,
    hooks,
    agentPlans: new Map(),
    streams,
    activities: {} as never,
    interactions: {} as never,
    now: () => "2030-01-01T00:00:00.000Z",
    transition: () => false,
    observeSubagent: () => false,
  });
  const event = (value: ProviderEventInput): ProviderEvent => ({
    providerId: "codex",
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    ...value,
  }) as ProviderEvent;
  return {
    active,
    conversation,
    databasePath,
    event,
    events,
    projector,
    scheduler,
    snapshots: () => snapshots,
    store,
    streams,
    workspace,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("authoritative provider text snapshots", () => {
  it("replaces every persisted assistant segment without appending correction text", async () => {
    const runtime = await snapshotRuntime();
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "first",
      text: "Stale first segment.",
    }));
    runtime.scheduler.runAll();
    runtime.streams.closeAssistantSegment(runtime.active);
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "second",
      text: " Stale second segment.",
    }));
    runtime.scheduler.runAll();
    runtime.streams.closeAssistantSegment(runtime.active);
    expect(runtime.store.conversationDetail(runtime.conversation.id)?.messages
      .filter(({ role }) => role === "assistant")).toHaveLength(2);

    runtime.projector.project(runtime.active, runtime.event({
      type: "text-snapshot",
      itemId: "second",
      text: "Authoritative replacement.",
    }));

    expect(runtime.store.conversationDetail(runtime.conversation.id)?.messages
      .filter(({ role }) => role === "assistant")).toEqual([
      expect.objectContaining({ content: "Authoritative replacement." }),
    ]);
    expect(runtime.events.flatMap((event) =>
      event.type === "agent.text" ? [event.text] : [])).toEqual([
      "Stale first segment.",
      " Stale second segment.",
    ]);
    expect(runtime.events).toContainEqual({
      type: "agent.text.replaced",
      conversationId: runtime.conversation.id,
      runId: runtime.active.turn.runId,
      turnId: runtime.active.turn.id,
      message: expect.objectContaining({
        role: "assistant",
        content: "Authoritative replacement.",
        turnId: runtime.active.turn.id,
      }),
    });
    expect(runtime.events).toContainEqual({
      type: "conversation.detail.invalidated",
      conversationId: runtime.conversation.id,
    });
    expect(runtime.snapshots()).toBe(1);

    runtime.store.close();
    const reopened = new RuntimeStore(
      runtime.databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.conversationDetail(runtime.conversation.id)?.messages
      .filter(({ role }) => role === "assistant")).toEqual([
      expect.objectContaining({ content: "Authoritative replacement." }),
    ]);
    reopened.close();
  });

  it("clears reset text without suppressing the next assistant delta", async () => {
    const runtime = await snapshotRuntime();
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "before-reset",
      text: "Obsolete answer.",
    }));
    runtime.scheduler.runAll();
    runtime.streams.closeAssistantSegment(runtime.active);
    runtime.projector.project(runtime.active, runtime.event({
      type: "text-snapshot",
      itemId: "conversation-reset",
      text: "",
    }));
    expect(runtime.events).toContainEqual({
      type: "agent.text.replaced",
      conversationId: runtime.conversation.id,
      runId: runtime.active.turn.runId,
      turnId: runtime.active.turn.id,
      message: null,
    });
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "after-reset",
      text: "Fresh answer.",
    }));
    runtime.streams.flush(runtime.active, "assistant");

    expect(runtime.store.conversationDetail(runtime.conversation.id)?.messages
      .filter(({ role }) => role === "assistant")).toEqual([
      expect.objectContaining({ content: "Fresh answer." }),
    ]);
    expect(runtime.events.flatMap((event) =>
      event.type === "agent.text" ? [event.text] : [])).toEqual([
      "Obsolete answer.",
      "Fresh answer.",
    ]);
    runtime.store.close();
  });

  it("rolls back snapshot replacement when sibling deletion fails", async () => {
    const runtime = await snapshotRuntime();
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "retained-first",
      text: "Keep first on rollback.",
    }));
    runtime.scheduler.runAll();
    runtime.streams.closeAssistantSegment(runtime.active);
    runtime.projector.project(runtime.active, runtime.event({
      type: "text",
      itemId: "retained-second",
      text: " Keep second on rollback.",
    }));
    runtime.scheduler.runAll();
    runtime.streams.closeAssistantSegment(runtime.active);
    const before = runtime.store.conversationDetail(runtime.conversation.id)!
      .messages.filter(({ role }) => role === "assistant");
    const raw = new Database(runtime.databasePath);
    raw.exec(`
      CREATE TRIGGER reject_snapshot_sibling_delete
      BEFORE DELETE ON messages
      WHEN OLD.content = 'Keep first on rollback.'
      BEGIN
        SELECT RAISE(ABORT, 'reject snapshot delete');
      END
    `);
    raw.close();

    expect(() => runtime.projector.project(runtime.active, runtime.event({
      type: "text-snapshot",
      itemId: "retained-second",
      text: "Must roll back.",
    }))).toThrow("reject snapshot delete");

    expect(runtime.store.conversationDetail(runtime.conversation.id)?.messages
      .filter(({ role }) => role === "assistant")).toEqual(before);
    expect(runtime.active.assistantText).toBe(
      "Keep first on rollback. Keep second on rollback.",
    );
    expect(runtime.events.some((event) =>
      event.type === "conversation.detail.invalidated")).toBe(false);
    runtime.store.close();
  });
});
