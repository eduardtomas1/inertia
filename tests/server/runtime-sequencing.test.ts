import { describe, expect, it } from "vitest";

import type { AppSnapshot, RuntimeMutationEvent } from "../../src/shared/contracts";
import {
  parseRuntimeResumeRequest,
  projectRuntimeFrame,
  RuntimeSequencer,
  runtimeMutationScope,
} from "../../src/server/runtime-sequencing";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function snapshot(): AppSnapshot {
  return {
    projects: [],
    conversations: [],
    runs: [],
    providers: [],
    settings: {} as AppSnapshot["settings"],
    activeProjectId: null,
    activeConversationId: null,
  };
}

function detailEvent(conversationId: string, text: string): RuntimeMutationEvent {
  return {
    type: "agent.text",
    conversationId,
    runId: "run",
    turnId: "turn",
    text,
  };
}

describe("RuntimeSequencer", () => {
  it("assigns one monotonic sequence only when a committed mutation is published", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    expect(sequencer.cursor().latestSequence).toBe(0);

    const first = sequencer.commit((sync) => ({
      type: "snapshot.updated",
      snapshot: { ...snapshot(), sync },
    }));
    const second = sequencer.commit(() => detailEvent(CONVERSATION_A, "ready"));

    expect(first.sync).toEqual({ runtimeGeneration: GENERATION, latestSequence: 1 });
    expect(first.event.type === "snapshot.updated" ? first.event.snapshot.sync : null).toEqual(first.sync);
    expect(second.sync.latestSequence).toBe(2);
    expect(sequencer.cursor().latestSequence).toBe(2);
  });

  it("replays after a cursor and replaces unsubscribed detail with lightweight cursors", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    sequencer.commit(() => detailEvent(CONVERSATION_A, "a"));
    sequencer.commit(() => detailEvent(CONVERSATION_B, "private-b"));
    sequencer.commit((sync) => ({
      type: "snapshot.updated",
      snapshot: { ...snapshot(), sync },
    }));

    const replay = sequencer.replay(GENERATION, 0, { conversationId: CONVERSATION_A });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") return;
    expect(replay.frames.map(({ type }) => type)).toEqual([
      "runtime.event",
      "runtime.cursor",
      "runtime.event",
    ]);
    expect(JSON.stringify(replay.frames)).not.toContain("private-b");
    expect(replay.frames.map(({ sync }) => sync.latestSequence)).toEqual([1, 2, 3]);
  });

  it("keeps a subscription switch contiguous while detail events race on either side", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    const beforeSwitch = sequencer.commit(() => detailEvent(CONVERSATION_A, "old detail"));
    const afterSwitch = sequencer.commit(() => detailEvent(CONVERSATION_B, "new detail"));

    expect(projectRuntimeFrame(beforeSwitch, { conversationId: CONVERSATION_B })).toEqual({
      type: "runtime.cursor",
      sync: beforeSwitch.sync,
    });
    expect(projectRuntimeFrame(afterSwitch, { conversationId: CONVERSATION_B })).toBe(afterSwitch);
    expect(afterSwitch.sync.latestSequence).toBe(beforeSwitch.sync.latestSequence + 1);
  });

  it("falls back to refresh for generation mismatch, ahead cursors, and evicted history", () => {
    const sequencer = new RuntimeSequencer({
      runtimeGeneration: GENERATION,
      maxReplayEvents: 2,
    });
    sequencer.commit(() => detailEvent(CONVERSATION_A, "one"));
    sequencer.commit(() => detailEvent(CONVERSATION_A, "two"));
    sequencer.commit(() => detailEvent(CONVERSATION_A, "three"));

    expect(sequencer.replay("22222222-2222-4222-8222-222222222222", 3, { conversationId: null }))
      .toMatchObject({ kind: "refresh", reason: "generation-mismatch" });
    expect(sequencer.replay(GENERATION, 4, { conversationId: null }))
      .toMatchObject({ kind: "refresh", reason: "cursor-ahead" });
    expect(sequencer.replay(GENERATION, 0, { conversationId: null }))
      .toMatchObject({ kind: "refresh", reason: "cursor-too-old" });
    expect(sequencer.replay(GENERATION, 1, { conversationId: CONVERSATION_A }))
      .toMatchObject({ kind: "replay" });
  });

  it("makes an oversized omitted event an explicit replay boundary", () => {
    const sequencer = new RuntimeSequencer({
      runtimeGeneration: GENERATION,
      maxReplayBytes: 700,
    });
    sequencer.commit(() => detailEvent(CONVERSATION_A, "x".repeat(1_000)));
    sequencer.commit(() => detailEvent(CONVERSATION_A, "small"));

    expect(sequencer.replay(GENERATION, 0, { conversationId: CONVERSATION_A }))
      .toMatchObject({ kind: "refresh", reason: "cursor-too-old" });
    const replay = sequencer.replay(GENERATION, 1, { conversationId: CONVERSATION_A });
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.frames).toHaveLength(1);
      expect(replay.frames[0]?.sync.latestSequence).toBe(2);
    }
  });
});

describe("runtime sequence helpers", () => {
  it("scopes shell and detail mutations without leaking another detail", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    const frame = sequencer.commit(() => detailEvent(CONVERSATION_B, "secret detail"));
    expect(runtimeMutationScope(frame.event)).toEqual({
      kind: "conversation-detail",
      conversationId: CONVERSATION_B,
    });
    expect(projectRuntimeFrame(frame, { conversationId: CONVERSATION_A })).toEqual({
      type: "runtime.cursor",
      sync: frame.sync,
    });
  });

  it("keeps provider maintenance global without disturbing detail cursors", () => {
    const sequencer = new RuntimeSequencer({ runtimeGeneration: GENERATION });
    sequencer.commit(() => detailEvent(CONVERSATION_A, "visible detail"));
    const maintenance = sequencer.commit(() => ({
      type: "provider.maintenance.operation",
      operation: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        providerId: "codex",
        status: "running",
        startedAt: "2026-07-27T12:00:00.000Z",
        finishedAt: null,
        beforeVersion: "0.1.0",
        afterVersion: null,
        targetVersion: "0.2.0",
        message: "Updating provider.",
        output: null,
        outputTruncated: false,
      },
    }));
    sequencer.commit(() => detailEvent(CONVERSATION_B, "private detail"));

    expect(runtimeMutationScope(maintenance.event)).toEqual({ kind: "shell" });
    const replay = sequencer.replay(
      GENERATION,
      0,
      { conversationId: CONVERSATION_A },
    );
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") return;
    expect(replay.frames.map(({ type }) => type)).toEqual([
      "runtime.event",
      "runtime.event",
      "runtime.cursor",
    ]);
    expect(replay.frames.map(({ sync }) => sync.latestSequence)).toEqual([
      1,
      2,
      3,
    ]);
    expect(JSON.stringify(replay.frames)).not.toContain("private detail");
  });

  it("parses only bounded same-path resume parameters", () => {
    const path = "/runtime/token";
    expect(parseRuntimeResumeRequest(path, path)).toEqual({ kind: "none" });
    expect(parseRuntimeResumeRequest(
      `${path}?runtimeGeneration=${GENERATION}&afterSequence=42&conversationId=${CONVERSATION_A}`,
      path,
    )).toEqual({
      kind: "resume",
      runtimeGeneration: GENERATION,
      afterSequence: 42,
      conversationId: CONVERSATION_A,
    });
    expect(parseRuntimeResumeRequest(`${path}?afterSequence=1`, path)).toEqual({ kind: "invalid" });
    expect(parseRuntimeResumeRequest(`${path}?runtimeGeneration=${GENERATION}&afterSequence=-1`, path))
      .toEqual({ kind: "invalid" });
    expect(parseRuntimeResumeRequest(`${path}?runtimeGeneration=${GENERATION}&afterSequence=1&extra=x`, path))
      .toEqual({ kind: "invalid" });
  });
});
