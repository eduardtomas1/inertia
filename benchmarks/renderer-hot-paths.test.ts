import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../src/shared/model-routing";
import { planFromText } from "../src/renderer/src/utils/planFromText";
import {
  createReasoningSummaryReader,
  parseReasoningSummary,
} from "../src/renderer/src/utils/reasoningSummary";
import {
  splitStreamingMarkdown,
  type StreamingMarkdownSplit,
} from "../src/renderer/src/utils/streamingMarkdownSplit";
import {
  buildResponseTimeline,
  stabilizeResponseTimeline,
  updateResponseTimelineForActivityDelta,
  type BuildResponseTimelineInput,
} from "../src/renderer/src/utils/response-timeline/model";
import { buildTurnExecutionStream } from "../src/renderer/src/utils/response-timeline/execution";
import {
  compareCreatedRecords,
  mergeProjectionRecords,
} from "../src/renderer/src/utils/terminalTurnProjection";
import {
  deliverDecodedServerEvent,
  deliverDecodedServerEventSync,
} from "../src/renderer/src/utils/connectionMessages";

interface BenchmarkRow {
  case: string;
  mode: string;
  medianMs: number;
}

function measureMedianMs(operation: () => void, samples = 9): number {
  operation();
  const times = Array.from({ length: samples }, () => {
    const start = performance.now();
    operation();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

async function measureMedianAsyncMs(operation: () => Promise<void>, samples = 5): Promise<number> {
  await operation();
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await operation();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

function legacyPlanFromText(streamingText: string) {
  const lines = streamingText.split("\n");
  return lines.flatMap((line, index) => {
    const match = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.{3,200})$/u.exec(line);
    if (!match) return [];
    return [{
      id: `step-${index}`,
      title: match[1]!.replace(/\*\*/g, "").trim(),
      status: "pending" as const,
      source: "streamed" as const,
    }];
  }).slice(0, 20);
}

function legacyMergeProjectionRecords<T extends { id: string }>(
  persisted: readonly T[],
  live: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  const merged = new Map(persisted.map((value) => [value.id, value]));
  for (const value of live) merged.set(value.id, value);
  return [...merged.values()].sort(compare);
}

function makeTranscriptFixture(turnCount = 150, activitiesPerTurn = 10): BuildResponseTimelineInput {
  const selection = providerNativeModelSelection({ providerId: "codex" });
  const baseMs = Date.parse("2026-10-25T10:00:00.000Z");
  const turns: AgentTurn[] = [];
  const messages: ChatMessage[] = [];
  const activities: AgentActivity[] = [];
  for (let t = 0; t < turnCount; t += 1) {
    const turnId = `turn-${String(t).padStart(4, "0")}`;
    const runId = `run-${String(t).padStart(4, "0")}`;
    const userMessageId = `msg-u-${String(t).padStart(4, "0")}`;
    const terminalId = t < turnCount - 1 ? `msg-a-${String(t).padStart(4, "0")}` : null;
    const requestedAt = new Date(baseMs + t * 60_000).toISOString();
    const completedAt = t < turnCount - 1 ? new Date(baseMs + t * 60_000 + 30_000).toISOString() : null;
    turns.push({
      id: turnId,
      conversationId: "conv-bench",
      runId,
      userMessageId,
      terminalAssistantMessageId: terminalId,
      providerId: "codex",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection),
      harnessId: selection.harnessId,
      backendProfileId: selection.backendProfileId,
      model: selection.modelId,
      modelAlias: null,
      reasoningEffort: "medium",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      providerSessionAfter: null,
      requestedAt,
      startedAt: requestedAt,
      completedAt,
      status: t < turnCount - 1 ? "completed" : "running",
      terminalReason: null,
      checkpointId: null,
      usageAtStart: null,
      usageAtCompletion: null,
      configurationRevision: 1,
      association: "authoritative",
      createdAt: requestedAt,
      updatedAt: completedAt ?? requestedAt,
    });
    messages.push({
      id: userMessageId,
      conversationId: "conv-bench",
      turnId,
      role: "user",
      content: `Request ${t}`,
      attachments: [],
      createdAt: requestedAt,
    });
    for (let c = 0; c < 2; c += 1) {
      messages.push({
        id: `msg-c-${String(t).padStart(4, "0")}-${c}`,
        conversationId: "conv-bench",
        turnId,
        role: "assistant",
        content: `Commentary ${t}.${c}`,
        attachments: [],
        createdAt: new Date(baseMs + t * 60_000 + (c + 1) * 5_000).toISOString(),
      });
    }
    if (terminalId) {
      messages.push({
        id: terminalId,
        conversationId: "conv-bench",
        turnId,
        role: "assistant",
        content: `Final reply for turn ${t}`,
        attachments: [],
        createdAt: completedAt!,
      });
    }
    for (let a = 0; a < activitiesPerTurn; a += 1) {
      activities.push({
        id: `act-${String(t).padStart(4, "0")}-${String(a).padStart(3, "0")}`,
        conversationId: "conv-bench",
        runId,
        turnId,
        kind: a % 2 === 0 ? "tool" : "command",
        title: `Step ${a}`,
        detail: `Detail ${a}`,
        status: "completed",
        createdAt: new Date(baseMs + t * 60_000 + 1_000 + a * 500).toISOString(),
      });
    }
  }
  return { turns, messages, activities, reasonings: [], checkpoints: [] };
}

describe("renderer hot paths benchmark", () => {
  it("measures Proposals 1, 5, and 6 hot paths", async () => {
    const rows: BenchmarkRow[] = [];

    // --- Proposal 1: planFromText early exit at 60 KB ---
    const bulletText = Array.from({ length: 1_200 }, (_, i) => `- Step ${i}: inspect module ${i} and verify invariants`).join("\n");
    expect(planFromText("", "running", bulletText).map(({ title }) => title))
      .toEqual(legacyPlanFromText(bulletText).map(({ title }) => title));
    rows.push({
      case: "planFromText (60 KB, 200 chunks)",
      mode: "legacy split+flatMap",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 200; i += 1) legacyPlanFromText(bulletText);
      }),
    });
    rows.push({
      case: "planFromText (60 KB, 200 chunks)",
      mode: "current early-exit",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 200; i += 1) planFromText("", "running", bulletText);
      }),
    });

    // --- Proposal 1: createReasoningSummaryReader vs parseReasoningSummary ---
    let reasoning60k = "";
    for (let s = 0; reasoning60k.length < 60_000; s += 1) {
      reasoning60k += `**Step ${s}: analyzing state**\n\nInspecting the projection and verifying invariants. `.repeat(4) + "\n\n";
    }
    reasoning60k = reasoning60k.slice(0, 60_000);
    const reasoningBase = reasoning60k.slice(0, 60_000 - 2_400);
    const reasoningChunks = Array.from({ length: 400 }, (_, i) =>
      reasoning60k.slice(reasoningBase.length + i * 6, reasoningBase.length + (i + 1) * 6));
    rows.push({
      case: "reasoning summary (60 KB, 400 chunks)",
      mode: "legacy full parseReasoningSummary",
      medianMs: measureMedianMs(() => {
        let text = reasoningBase;
        parseReasoningSummary(text);
        for (const chunk of reasoningChunks) {
          text = `${text}${chunk}`;
          parseReasoningSummary(text);
        }
      }, 5),
    });
    rows.push({
      case: "reasoning summary (60 KB, 400 chunks)",
      mode: "current createReasoningSummaryReader",
      medianMs: measureMedianMs(() => {
        const read = createReasoningSummaryReader();
        let text = reasoningBase;
        read(text);
        for (const chunk of reasoningChunks) {
          text = `${text}${chunk}`;
          read(text);
        }
      }, 5),
    });

    // --- Proposal 1: splitStreamingMarkdown incremental at 60 KB ---
    const mdParagraphs = Array.from({ length: 240 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(45)}`).join("\n\n");
    const mdBase = mdParagraphs.slice(0, mdParagraphs.length - 2_400);
    const mdChunks = Array.from({ length: 400 }, (_, i) =>
      mdParagraphs.slice(mdBase.length + i * 6, mdBase.length + (i + 1) * 6));
    rows.push({
      case: "splitStreamingMarkdown (60 KB, 400 chunks)",
      mode: "current incremental + cached defs",
      medianMs: measureMedianMs(() => {
        let text = mdBase;
        let split: StreamingMarkdownSplit | undefined = splitStreamingMarkdown(text);
        for (const chunk of mdChunks) {
          text = `${text}${chunk}`;
          split = splitStreamingMarkdown(text, split);
        }
      }, 5),
    });

    // --- Proposal 5: Long-transcript build, 200 activity deltas, execution stream ---
    const fixture = makeTranscriptFixture(150, 10);
    rows.push({
      case: "buildResponseTimeline (150 turns / 1,500 acts)",
      mode: "current",
      medianMs: measureMedianMs(() => {
        buildResponseTimeline(fixture);
      }, 7),
    });

    const initialTimeline = buildResponseTimeline(fixture);
    const lastTurnId = fixture.turns.at(-1)!.id;
    const lastRunId = fixture.turns.at(-1)!.runId;
    const lastActivityBaseMs = Date.parse(fixture.activities.at(-1)!.createdAt);
    rows.push({
      case: "200 activity deltas + stabilize (150 turns)",
      mode: "current incremental patch",
      medianMs: measureMedianMs(() => {
        let prevActivities = fixture.activities;
        let prevTimeline = initialTimeline;
        for (let i = 0; i < 200; i += 1) {
          const nextActivities = prevActivities.slice();
          nextActivities[nextActivities.length - 1] = {
            ...nextActivities[nextActivities.length - 1]!,
            detail: `Updated output ${i}`,
          };
          if (i % 10 === 0) {
            nextActivities.push({
              id: `act-live-${i}`,
              conversationId: "conv-bench",
              runId: lastRunId,
              turnId: lastTurnId,
              kind: "command",
              title: `Live step ${i}`,
              detail: `Output ${i}`,
              status: "running",
              createdAt: new Date(lastActivityBaseMs + (i + 1) * 100).toISOString(),
            });
          }
          const patched = updateResponseTimelineForActivityDelta(
            { ...fixture, activities: nextActivities },
            prevActivities,
            prevTimeline,
          )!;
          prevTimeline = stabilizeResponseTimeline(patched, prevTimeline);
          prevActivities = nextActivities;
        }
      }, 5),
    });

    const bigTurn = initialTimeline.find((item) => item.kind === "turn")!;
    if (bigTurn.kind === "turn") {
      const heavyTurn = {
        ...bigTurn.turn,
        activities: fixture.activities.slice(0, 300),
        commentaryMessages: fixture.messages.filter(({ role }) => role === "assistant").slice(0, 20),
        followUpMessages: fixture.messages.filter(({ role }) => role === "user").slice(0, 20),
      };
      rows.push({
        case: "buildTurnExecutionStream (300 acts + 40 msgs)",
        mode: "current",
        medianMs: measureMedianMs(() => {
          for (let i = 0; i < 20; i += 1) buildTurnExecutionStream(heavyTurn);
        }, 7),
      });
    }

    // --- Proposal 6: mergeProjectionRecords (settled & live) + WS frame dispatch ---
    rows.push({
      case: "mergeProjectionRecords settled (1,500 acts × 50)",
      mode: "legacy Map+sort",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 50; i += 1) {
          legacyMergeProjectionRecords(fixture.activities, [], compareCreatedRecords);
        }
      }, 7),
    });
    rows.push({
      case: "mergeProjectionRecords settled (1,500 acts × 50)",
      mode: "current zero-copy fast path",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 50; i += 1) {
          mergeProjectionRecords(fixture.activities, [], compareCreatedRecords);
        }
      }, 7),
    });

    const liveBatch: AgentActivity[] = [
      { ...fixture.activities.at(-1)!, detail: "live update" },
      {
        ...fixture.activities.at(-1)!,
        id: "act-live-new",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ];
    rows.push({
      case: "mergeProjectionRecords live (1,500 + 2 × 50)",
      mode: "legacy Map+sort",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 50; i += 1) {
          legacyMergeProjectionRecords(fixture.activities, liveBatch, compareCreatedRecords);
        }
      }, 7),
    });
    rows.push({
      case: "mergeProjectionRecords live (1,500 + 2 × 50)",
      mode: "current incremental merge",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 50; i += 1) {
          mergeProjectionRecords(fixture.activities, liveBatch, compareCreatedRecords);
        }
      }, 7),
    });

    const sampleFrame = JSON.stringify({
      type: "agent.text",
      conversationId: "conv-bench",
      runId: "run-0001",
      turnId: "turn-0001",
      text: "hello ",
    });
    // Warm up the dynamic parser once.
    await deliverDecodedServerEvent(sampleFrame, () => undefined, () => undefined);
    rows.push({
      case: "WS frame dispatch (5,000 agent.text frames)",
      mode: "legacy async deliverDecodedServerEvent",
      medianMs: await measureMedianAsyncMs(async () => {
        for (let i = 0; i < 5_000; i += 1) {
          await deliverDecodedServerEvent(sampleFrame, () => undefined, () => undefined);
        }
      }, 3),
    });
    rows.push({
      case: "WS frame dispatch (5,000 agent.text frames)",
      mode: "current sync deliverDecodedServerEventSync",
      medianMs: measureMedianMs(() => {
        for (let i = 0; i < 5_000; i += 1) {
          void deliverDecodedServerEventSync(sampleFrame, () => undefined, () => undefined);
        }
      }, 5),
    });

    console.table(rows.map((row) => ({
      case: row.case,
      mode: row.mode,
      "median ms": row.medianMs.toFixed(3),
    })));
  });
});
