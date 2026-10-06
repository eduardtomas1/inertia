import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { RuntimeStore } from "../../src/server/database";
import {
  MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
  MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
  mergeProviderActivityOutputWithinTurnBudget,
} from "../../src/server/provider/activity-detail";

const CONVERSATIONS = 1_000;
const ARCHIVED_CONVERSATIONS = 200;
const HEAVY_TURNS = 40;
const ACTIVITIES_PER_HEAVY_TURN = 8;
const HISTORY_PAGE_TURNS = 20;
const MAX_SHELL_SNAPSHOT_BYTES_PER_CONVERSATION = 2_200;
const MAX_SHELL_SNAPSHOT_MS = 250;
const MAX_HISTORY_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_ACTIVITY_EVENT_BYTES = 36 * 1024;
const MAX_SHELL_EVENT_BYTES = 12 * 1024;

let directory = "";
let store: RuntimeStore;
let heavyConversationId = "";
let projectId = "";

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function at(index: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, 0, index)).toISOString();
}

function completedTurn(conversationId: string, index: number, answer: string) {
  const requestedAt = at(index);
  const { turn } = store.beginAgentTurn({
    id: `turn-${conversationId}-${index}`,
    runId: `run-${conversationId}-${index}`,
    conversationId,
    content: `Request ${index}`,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 1,
    association: "authoritative",
    requestedAt,
  });
  const message = store.createMessage(
    conversationId,
    answer,
    "assistant",
    [],
    turn.id,
    requestedAt,
  );
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    startedAt: requestedAt,
    completedAt: requestedAt,
    updatedAt: requestedAt,
    terminalAssistantMessageId: message.id,
  });
  return turn;
}

function commandDetail(activity: number, seed: number, turnChars: number) {
  const command = `Command:\nnpm test ${activity}`;
  const output = Array.from({ length: 1_400 }, (_, line) =>
    `test ${seed}.${line} passed in ${line % 97} ms\n`).join("");
  return mergeProviderActivityOutputWithinTurnBudget(
    command,
    output,
    false,
    turnChars + command.length,
  );
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "inertia-payload-budget-"));
  store = new RuntimeStore(join(directory, "budget.sqlite"), directory, {
    recoverInterruptedRuns: false,
  });
  const database = (store as unknown as { database: Database.Database })
    .database;
  projectId = store.createProject("Budget", directory).id;
  database.transaction(() => {
    for (let index = 0; index < CONVERSATIONS; index += 1) {
      const conversation = store.createConversation(
        projectId,
        `Conversation ${index}`,
      );
      completedTurn(conversation.id, index, `Answer ${index}`);
      if (index < ARCHIVED_CONVERSATIONS) {
        store.archiveConversation(conversation.id, true);
      }
      if (index === CONVERSATIONS - 1) heavyConversationId = conversation.id;
    }
    for (let turnIndex = 0; turnIndex < HEAVY_TURNS; turnIndex += 1) {
      const turn = completedTurn(
        heavyConversationId,
        CONVERSATIONS + turnIndex,
        `Heavy answer ${turnIndex}`,
      );
      let turnChars = 0;
      for (
        let activity = 0;
        activity < ACTIVITIES_PER_HEAVY_TURN;
        activity += 1
      ) {
        const streamed = commandDetail(
          activity,
          turnIndex * 100 + activity,
          turnChars,
        );
        turnChars = streamed.totalChars;
        store.addActivity({
          conversationId: heavyConversationId,
          runId: turn.runId,
          turnId: turn.id,
          kind: "command",
          title: `npm test ${activity}`,
          detail: streamed.detail,
          status: "completed",
          createdAt: at(CONVERSATIONS + turnIndex),
        });
      }
      expect(turnChars).toBeLessThanOrEqual(
        MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
      );
    }
  })();
}, 60_000);

afterAll(() => {
  store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("runtime transport payload budget", () => {
  it("keeps the shell snapshot of 1,000 conversations within its byte and time ceilings", () => {
    const samples: number[] = [];
    let snapshotBytes = 0;
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      const snapshot = store.shellSnapshot([]);
      snapshotBytes = bytes(snapshot);
      samples.push(performance.now() - started);
      expect(snapshot.conversations).toHaveLength(CONVERSATIONS);
      expect(snapshot.conversations.filter(({ archivedAt }) => archivedAt))
        .toHaveLength(ARCHIVED_CONVERSATIONS);
    }
    const median = [...samples].sort((left, right) => left - right)[2]!;

    expect(snapshotBytes).toBeLessThanOrEqual(
      CONVERSATIONS * MAX_SHELL_SNAPSHOT_BYTES_PER_CONVERSATION,
    );
    expect(median).toBeLessThanOrEqual(MAX_SHELL_SNAPSHOT_MS);
  });

  it("keeps the latest history page of heavy tool output within its byte ceiling", () => {
    const page = store.conversationHistory(heavyConversationId)!;
    const event: ServerEvent = {
      type: "request.result",
      requestId: "history",
      result: {
        kind: "conversation.detail",
        conversationId: heavyConversationId,
        state: "ready",
        detail: page,
      },
    };
    const pageBytes = bytes(event);

    expect(page.agentTurns).toHaveLength(HISTORY_PAGE_TURNS);
    expect(page.activities).toHaveLength(
      HISTORY_PAGE_TURNS * ACTIVITIES_PER_HEAVY_TURN,
    );
    expect(pageBytes).toBeLessThanOrEqual(MAX_HISTORY_PAGE_BYTES);
    expect(parseServerEvent(event)).toEqual(event);
  });

  it("keeps one full-size tool activity event and one shell event within their ceilings", () => {
    const activity = store.conversationDetail(heavyConversationId)!.activities
      .reduce((largest, candidate) =>
        (candidate.detail?.length ?? 0) > (largest.detail?.length ?? 0)
          ? candidate
          : largest);
    const activityEvent: ServerEvent = { type: "agent.activity", activity };
    const conversation = store.conversationShell(heavyConversationId)!;
    for (let index = 0; index < 20; index += 1) {
      store.createWorkspaceRun({
        kind: "check",
        projectId,
        conversationId: heavyConversationId,
        label: `npm test ${index}`,
        detail: `Codex · ${conversation.title}`,
        status: "succeeded",
        port: null,
      });
    }
    const shellEvent: ServerEvent = {
      type: "conversation.shell.updated",
      conversation: { ...conversation, pendingApproval: false, pendingInput: false },
      runs: store.workspaceRunsForConversation(heavyConversationId),
    };
    const activityBytes = bytes(activityEvent);
    const shellBytes = bytes(shellEvent);

    expect(activity.detail).toHaveLength(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS);
    expect(activityBytes).toBeLessThanOrEqual(MAX_ACTIVITY_EVENT_BYTES);
    expect(shellBytes).toBeLessThanOrEqual(MAX_SHELL_EVENT_BYTES);
    expect(parseServerEvent(activityEvent)).toEqual(activityEvent);
    expect(parseServerEvent(shellEvent)).toEqual(shellEvent);
  });
});
