import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeSystemSuspendTracker } from "../../src/main/runtime-system-suspend-tracker";
import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("system suspend repository", () => {
  it("retains an idle suspend interval without charging later work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-system-suspend-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);
    const store = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });

    const idle = {
      id: "11111111-1111-4111-8111-111111111111",
      suspendedAt: "2026-08-26T08:00:00.000Z",
      resumedAt: "2026-08-26T08:30:00.000Z",
    };
    expect(store.systemSuspends.record(idle)).toEqual([]);

    const project = store.createProject("Idle suspend", workspace);
    const conversation = store.createConversation(project.id, "Later work", {
      providerId: "codex",
    });
    const message = store.createMessage(
      conversation.id,
      "Start after the machine resumes.",
      "user",
      [],
      null,
      "2026-08-26T09:00:00.000Z",
    );
    const turn = store.createAgentTurn({
      conversationId: conversation.id,
      runId: randomUUID(),
      userMessageId: message.id,
      providerId: "codex",
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      requestedAt: "2026-08-26T09:00:00.000Z",
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt: "2026-08-26T09:00:00.000Z",
      completedAt: "2026-08-26T09:10:00.000Z",
      updatedAt: "2026-08-26T09:10:00.000Z",
    });

    expect(store.agentTurn(turn.id).suspendedDurationMs).toBe(0);
    expect(store.systemSuspends.read(
      "2026-08-26T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
    )).toEqual([idle]);
    store.close();
  });

  it("retries a failed head before a later interval after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-system-suspend-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    const statePath = join(directory, "runtime-system-suspends.json");
    await mkdir(workspace);
    const initial = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const project = initial.createProject("Suspend replay", workspace);
    const conversation = initial.createConversation(project.id, "Long run", {
      providerId: "codex",
    });
    const message = initial.createMessage(
      conversation.id,
      "Keep accounting ordered.",
      "user",
      [],
      null,
      "2026-08-26T09:00:00.000Z",
    );
    const turn = initial.createAgentTurn({
      conversationId: conversation.id,
      runId: randomUUID(),
      userMessageId: message.id,
      providerId: "codex",
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      requestedAt: "2026-08-26T09:00:00.000Z",
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    initial.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt: "2026-08-26T09:00:00.000Z",
      completedAt: "2026-08-26T11:00:00.000Z",
      updatedAt: "2026-08-26T11:00:00.000Z",
    });
    initial.close();

    const tracker = new RuntimeSystemSuspendTracker({ statePath });
    tracker.suspend("2026-08-26T10:00:00.000Z");
    const first = tracker.resume("2026-08-26T10:20:00.000Z")!;
    expect(tracker.claim(1)).toEqual(first);
    // Generation one fails before the repository can acknowledge the head.
    tracker.release(first.id, 1);
    tracker.suspend("2026-08-26T10:30:00.000Z");
    const second = tracker.resume("2026-08-26T10:40:00.000Z")!;
    expect(tracker.claim(1)).toEqual(first);
    tracker.release(first.id, 1);

    const replay = new RuntimeSystemSuspendTracker({ statePath });
    const restarted = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    expect(replay.claim(2)).toEqual(first);
    expect(restarted.systemSuspends.record(first)).toEqual([conversation.id]);
    expect(replay.acknowledge(first.id, 2)).toBe(true);
    expect(replay.claim(2)).toEqual(second);
    expect(restarted.systemSuspends.record(second)).toEqual([conversation.id]);
    expect(replay.acknowledge(second.id, 2)).toBe(true);

    expect(restarted.agentTurn(turn.id).suspendedDurationMs).toBe(30 * 60_000);
    expect(restarted.systemSuspends.read(
      "2026-08-26T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
    )).toEqual([first, second]);
    restarted.close();
  });

  it("reconciles a backward wall-clock correction with persisted resume order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-system-suspend-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);

    const initial = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const project = initial.createProject("Suspend timing", workspace);
    const conversation = initial.createConversation(project.id, "Long run", {
      providerId: "codex",
    });
    const message = initial.createMessage(
      conversation.id,
      "Run across a system sleep.",
      "user",
      [],
      null,
      "2026-08-26T09:00:00.000Z",
    );
    const turn = initial.createAgentTurn({
      conversationId: conversation.id,
      runId: randomUUID(),
      userMessageId: message.id,
      providerId: "codex",
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      requestedAt: "2026-08-26T09:00:00.000Z",
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    initial.updateAgentTurnLifecycle(turn.id, {
      status: "completed",
      startedAt: "2026-08-26T09:00:00.000Z",
      completedAt: "2026-08-26T11:00:00.000Z",
      updatedAt: "2026-08-26T11:00:00.000Z",
    });
    const first = {
      id: "11111111-1111-4111-8111-111111111111",
      suspendedAt: "2026-08-26T10:00:00.000Z",
      resumedAt: "2026-08-26T10:20:00.000Z",
    };
    expect(initial.systemSuspends.record(first)).toEqual([conversation.id]);
    initial.close();

    const restarted = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const partiallyOverlapping = {
      id: "22222222-2222-4222-8222-222222222222",
      suspendedAt: "2026-08-26T10:15:00.000Z",
      resumedAt: "2026-08-26T10:30:00.000Z",
    };
    const entirelyEarlier = {
      id: "33333333-3333-4333-8333-333333333333",
      suspendedAt: "2026-08-26T09:50:00.000Z",
      resumedAt: "2026-08-26T09:55:00.000Z",
    };
    expect(restarted.systemSuspends.record(partiallyOverlapping))
      .toEqual([conversation.id]);
    expect(restarted.systemSuspends.record(entirelyEarlier)).toEqual([]);
    expect(restarted.systemSuspends.record(partiallyOverlapping)).toEqual([]);
    expect(restarted.systemSuspends.record(entirelyEarlier)).toEqual([]);

    expect(restarted.agentTurn(turn.id).suspendedDurationMs).toBe(30 * 60_000);
    expect(restarted.systemSuspends.read(
      "2026-08-26T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
    )).toEqual([
      first,
      {
        ...partiallyOverlapping,
        suspendedAt: first.resumedAt,
      },
      {
        ...entirelyEarlier,
        suspendedAt: partiallyOverlapping.resumedAt,
        resumedAt: partiallyOverlapping.resumedAt,
      },
    ]);
    restarted.close();
  });
});
