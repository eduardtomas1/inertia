import { describe, expect, it } from "vitest";

import { boundedText, type JsonObject } from "../../src/server/codex/protocol";
import { AcpCompactionProjection } from "../../src/server/provider/acp-compaction-projection";
import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { acpStopReasonMessage } from "../../src/server/provider/acp-stop-reasons";
import { askCursorPermission } from "../../src/server/provider/cursor-acp-permissions";
import { emitCursorMetadata } from "../../src/server/provider/cursor-acp-metadata";
import {
  boundProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "../../src/server/provider/activity-detail";
import {
  createAgentHarnessEmitter,
  type AgentHarnessEvent,
} from "../../src/server/provider/agent-harness";
import {
  boundedClaudeEventText,
  boundedClaudeLabel,
  ClaudeProjectedTextLedger,
  claudeDetailLines,
  MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS,
  MAX_CLAUDE_STREAM_CORRELATION_CHARS,
} from "../../src/server/provider/claude-message-projector-support";
import { claudeModelScopedWindows } from "../../src/server/provider/claude-rate-limit-windows";
import { parseGrokExitPlanRequest } from "../../src/server/provider/grok-acp-extensions";
import { grokErrorDetail, grokStopFailure } from "../../src/server/provider/grok-acp-support";
import { planSteps as grokPlanSteps } from "../../src/server/provider/grok-acp-projection";
import { kimiErrorDetail, kimiStopFailure } from "../../src/server/provider/kimi-acp-support";
import { planSteps as kimiPlanSteps } from "../../src/server/provider/kimi-acp-projection";
import { markdownPlanSteps } from "../../src/server/provider/markdown-plan-steps";
import {
  createOpenCodeEventState,
  openCodeCanonicalResult,
  settleOpenCodePromptOutput,
} from "../../src/server/provider/opencode-event-projection";
import { bounded as boundedOpenCodeText } from "../../src/server/provider/opencode-sdk-support";
import { OpenCode2Events } from "../../src/server/provider/opencode2-events";
import { OpenCode2Interactions } from "../../src/server/provider/opencode2-interactions";
import { openCode2Models } from "../../src/server/provider/opencode2-support";
import { PiDialogs } from "../../src/server/provider/pi-dialogs";
import { PiEvents } from "../../src/server/provider/pi-events";
import { piModels } from "../../src/server/provider/pi-models";
import { nativeProviderRunInput } from "./model-route-fixture";
import {
  boundedSubagentLabel,
  boundedSubagentText,
} from "../../src/server/provider/subagent-trace";

const ROCKET = "\u{1F680}";
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function harnessEvents(providerId: "pi" | "opencode" | "cursor") {
  const events: AgentHarnessEvent[] = [];
  const emitter = createAgentHarnessEmitter(providerId, "truncation", { onEvent: (event) => events.push(event) }, "run", "turn", "/workspace");
  const activityDetails = () => events.flatMap((event) => event.type === "activity" && event.detail ? [event.detail] : []);
  const rich = () => events.flatMap((event) => event.type === "extension" ? [event.event as unknown as JsonObject] : []);
  return { emitter, activityDetails, rich };
}

/** `keep` code units of `x`, then a rocket whose high half is unit `keep`. */
function crossing(keep: number, after = " and more"): string {
  return `${"x".repeat(keep)}${ROCKET}${after}`;
}

describe("Claude provider text truncation", () => {
  it("cuts subagent text and labels on a code point boundary", () => {
    expect(boundedSubagentText(crossing(9), 10)).toBe("x".repeat(9));
    expect(boundedSubagentText(crossing(8), 10)).toBe(`${"x".repeat(8)}${ROCKET}`);
    expect(boundedSubagentLabel(crossing(9), 10)).toBe("x".repeat(9));
  });

  it("cuts projected event text, labels and activity details on a code point boundary", () => {
    const max = MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS;
    expect(boundedClaudeEventText(crossing(max - 1))).toBe("x".repeat(max - 1));
    expect(boundedClaudeLabel(crossing(239), "Tool")).toBe("x".repeat(239));
    expect(claudeDetailLines(["Reason:", crossing(max - 9)])).toBe(`Reason:\n${"x".repeat(max - 9)}`);
  });

  it("never streams the high half of a rocket at the correlation cap", () => {
    const max = MAX_CLAUDE_STREAM_CORRELATION_CHARS;
    const ledger = new ClaudeProjectedTextLedger();
    expect(ledger.append("text-1", crossing(max - 1))).toBe("x".repeat(max - 1));
    expect(LONE_SURROGATE.test(ledger.snapshot())).toBe(false);
    ledger.replace("text-1", crossing(max - 1, ""));
    expect(ledger.snapshot()).toBe("x".repeat(max - 1));
  });

  it("cuts a model's weekly window name on a code point boundary", () => {
    const [window] = claudeModelScopedWindows([{ display_name: crossing(79) }]);
    expect(LONE_SURROGATE.test(window!.label)).toBe(false);
    expect(window!.label).toContain("x".repeat(79));
  });
});

describe("shared provider activity bounds", () => {
  it("cuts the head and keeps the tail of an oversized detail on code point boundaries", () => {
    // With a 100-unit limit on 200 units the head keeps 41 units and the tail
    // keeps the last 21; each rocket straddles one of those cuts.
    const value = `${"a".repeat(40)}${ROCKET}${"b".repeat(136)}${ROCKET}${"c".repeat(20)}`;
    expect(value).toHaveLength(200);
    expect(boundProviderActivityDetail(value, 100))
      .toBe(`${"a".repeat(40)}\n… [100 or more characters omitted] …\n${"c".repeat(20)}`);
    expect(boundProviderActivityDetail(crossing(4), 5)).toBe("xxxx");
  });

  it("cuts a failure summary on a code point boundary", () => {
    expect(sanitizeProviderFailureSummary(crossing(479), "fallback")).toBe("x".repeat(479));
  });

  it("cuts an activity label on a code point boundary", () => {
    const events: AgentHarnessEvent[] = [];
    const emitter = createAgentHarnessEmitter("claude", "truncation", { onEvent: (event) => events.push(event) }, "run", "turn");
    emitter.activity("tool", "started", crossing(239), { activityId: "tool-1" });
    expect(events).toEqual([expect.objectContaining({ type: "activity", label: "x".repeat(239) })]);
  });
});

describe("other providers' text truncation", () => {
  it("cuts Codex bounded text on a code point boundary", () => {
    expect(boundedText(crossing(9), 10)).toBe("x".repeat(9));
  });

  const max = 1024 * 1024;

  it("cuts an ACP stop reason on a code point boundary", () => {
    expect(acpStopReasonMessage("Cursor", crossing(63))).toBe(`Cursor stopped with reason: ${"x".repeat(63)}.`);
    for (const failure of [grokStopFailure(crossing(159)), kimiStopFailure(crossing(159))]) {
      expect(failure).toMatchObject({ technicalDetail: `Stop reason: ${"x".repeat(159)}`, terminalEvent: `session/prompt:${"x".repeat(159)}` });
    }
  });

  it.each([["Grok", grokErrorDetail], ["Kimi", kimiErrorDetail]])("cuts a %s error detail on a code point boundary", (_name, errorDetail) => {
    expect(errorDetail(new Error(crossing(max - 1)), "fallback")).toBe("x".repeat(max - 1));
  });

  it.each([["Grok", grokPlanSteps], ["Kimi", kimiPlanSteps]])("cuts a %s plan step on a code point boundary", (_name, planSteps) => {
    expect(planSteps([{ content: crossing(max - 1), status: "pending" }])).toEqual([{ step: "x".repeat(max - 1), status: "pending" }]);
  });

  it("cuts Pi and OpenCode 2 model names on a code point boundary", () => {
    expect(piModels({ models: [{ provider: "acme", id: "model", name: crossing(199) }] })[0]?.label).toBe("x".repeat(199));
    expect(openCode2Models({ data: [{ providerID: "acme", id: "model", name: crossing(199), variants: [], enabled: true }] })[0]?.label)
      .toBe("x".repeat(199));
  });

  it("cuts a Grok plan on a code point boundary", () => {
    expect(parseGrokExitPlanRequest({ sessionId: "session-1", toolCallId: "call-1", planContent: crossing(256 * 1024 - 1) }).plan)
      .toBe("x".repeat(256 * 1024 - 1));
  });

  it("cuts a markdown plan step and OpenCode event text on a code point boundary", () => {
    expect(markdownPlanSteps(`- ${crossing(9)}`, 10)).toEqual([{ step: "x".repeat(9), status: "pending" }]);
    expect(boundedOpenCodeText(crossing(max - 1))).toBe("x".repeat(max - 1));
  });

  it("cuts Pi tool input and output details on a code point boundary", () => {
    const f = harnessEvents("pi");
    const pi = new PiEvents(f.emitter, {});
    // `{"q":"` is six code units, so the 16 KiB cut lands inside the rocket.
    pi.receive({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { q: crossing(16_384 - 7) } });
    pi.receive({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: [{ type: "text", text: crossing(16_383) }] } });
    expect(f.activityDetails()).toEqual([`{"q":"${"x".repeat(16_384 - 7)}`, "x".repeat(16_383)]);
  });

  it("cuts OpenCode 2 tool input, output and error details on a code point boundary", () => {
    const f = harnessEvents("opencode");
    const events = new OpenCode2Events(f.emitter, {}, new AcpSecretRedactor({}));
    for (const [id, last] of [["call_1", { type: "session.tool.success", content: [{ type: "text", text: crossing(16_383) }] }],
      ["call_2", { type: "session.tool.failed", error: { message: crossing(16_383) } }]] as const) {
      const data = { assistantMessageID: "msg_1", id };
      events.receive({ type: "session.tool.input.started", data: { ...data, name: "read" } });
      events.receive({ type: "session.tool.called", data: { ...data, input: { q: crossing(16_384 - 7) } } });
      const { type, ...rest } = last;
      events.receive({ type, data: { ...data, ...rest } });
    }
    const input = `{"q":"${"x".repeat(16_384 - 7)}`;
    expect(f.activityDetails()).toEqual([input, "x".repeat(16_383), input, "x".repeat(16_383)]);
  });

  it("cuts a Pi dialog title and message on a code point boundary", () => {
    const f = harnessEvents("pi");
    const dialogs = new PiDialogs(f.emitter, new AcpSecretRedactor({}), () => undefined, "managed-approval");
    try {
      dialogs.receive({ id: "dialog-1", method: "input", title: crossing(239), message: crossing(32_767) });
      expect(f.rich()).toEqual([expect.objectContaining({
        type: "input",
        request: expect.objectContaining({ questions: [expect.objectContaining({ header: "x".repeat(239), question: "x".repeat(32_767) })] }),
      })]);
    } finally {
      dialogs.close();
    }
  });

  it("cuts OpenCode 2 permission and form text on a code point boundary", () => {
    const f = harnessEvents("opencode");
    const interactions = new OpenCode2Interactions({ request: async () => undefined }, f.emitter, new AcpSecretRedactor({}), () => undefined);
    const resources = Array.from({ length: 4 }, () => "r".repeat(8_000));
    // Four resources and four newlines fill 32,004 units; the cut at 32 KiB lands in the rocket.
    interactions.receive("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "read", resources: [...resources, crossing(763)] }, "ses_1");
    interactions.receive("form.created", { form: { id: "frm_1", sessionID: "ses_1", fields: [{
      key: "answer", type: "string", title: crossing(239), description: crossing(32_767),
      options: [{ value: "a", label: "A", description: crossing(4_095) }],
    }] } }, "ses_1");
    const [approval, input] = f.rich() as Array<{ request: { detail?: string; questions?: Array<Record<string, unknown>> } }>;
    expect(approval!.request.detail).toBe(`${resources.join("\n")}\n${"x".repeat(763)}`);
    expect(input!.request.questions![0]).toMatchObject({
      header: "x".repeat(239),
      question: "x".repeat(32_767),
      options: [{ id: "0", label: "A", description: "x".repeat(4_095) }],
    });
    interactions.close();
  });

  it("cuts an unknown ACP compaction status on a code point boundary", () => {
    const f = harnessEvents("cursor");
    new AcpCompactionProjection("Cursor", "cursor", f.emitter).observeUpdate({ compactionId: "compact-1", status: crossing(199) });
    expect(f.activityDetails()).toEqual([`Status: ${"x".repeat(199)}`]);
  });

  it("cuts a Cursor approval title and detail on a code point boundary", async () => {
    const f = harnessEvents("cursor");
    const abort = new AbortController();
    const request = {
      sessionId: "cursor-session",
      // `{"q":"` is six code units, so the 1 MiB cut lands inside the rocket.
      toolCall: { toolCallId: "call-1", title: crossing(max - 1), kind: "read" as const, rawInput: { q: crossing(max - 7) } },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    };
    const decision = askCursorPermission(request, request, abort.signal, {
      input: nativeProviderRunInput({ providerId: "cursor", conversationId: "cursor-approval", cwd: "/workspace", prompt: "Run", interactionMode: "build", access: "supervised" }),
    } as Parameters<typeof askCursorPermission>[3], f.emitter.rich, new Map());
    const [approval] = f.rich() as Array<{ type: string; request: { title: string; detail: string } }>;
    abort.abort();
    await decision;
    expect(approval!.request.title).toBe("x".repeat(max - 1));
    expect(approval!.request.detail).toBe(`{"q":"${"x".repeat(max - 7)}`);
  });

  it("cuts Cursor model labels on a code point boundary", () => {
    const f = harnessEvents("cursor");
    emitCursorMetadata([{
      id: "model", name: "Model", type: "select", category: "model", currentValue: "model-a",
      options: [{ value: "model-a", name: crossing(max - 1), description: crossing(max - 1) }],
    }], false, f.emitter);
    const [metadata] = f.rich() as Array<{ metadata: { models: Array<{ label: string; description: string }> } }>;
    expect(metadata!.metadata.models[0]).toMatchObject({ label: "x".repeat(max - 1), description: "x".repeat(max - 1) });
  });

  it("cuts OpenCode's canonical and settled answer text on a code point boundary", () => {
    // Fifteen full 256 KiB parts leave 256 KiB of the 4 MiB answer bound, and
    // the sixteenth part's rocket straddles that cut.
    const part = 256 * 1024;
    const state = createOpenCodeEventState();
    const emitted = new Map<string, string>();
    for (let index = 0; index < 16; index += 1) {
      const id = `part-${index}`;
      state.parts.set(id, { messageId: "message-1", type: "text", snapshot: null });
      emitted.set(id, index < 15 ? "a".repeat(part) : crossing(part - 1));
      state.retainedPartChars += emitted.get(id)!.length;
    }
    const expected = `${"a".repeat(15 * part)}${"x".repeat(part - 1)}`;
    expect(openCodeCanonicalResult(emitted, state)).toEqual({ text: expected, truncated: true });
    settleOpenCodePromptOutput("prompt-1", ["message-1"], emitted, state);
    expect(state.settledText).toBe(expected);
    expect(state.settledTextTruncated).toBe(true);
  });
});
