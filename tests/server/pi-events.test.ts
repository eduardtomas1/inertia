// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { createAgentHarnessEmitter, type AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { PiEvents, segmentClosingEmitter } from "../../src/server/provider/pi-events";

/** Wired like the harness: every segment-closing emission (here `emit`, as the extension UI uses it) tells Pi first. */
function fixture() {
  const output: AgentHarnessEvent[] = [];
  const emit = segmentClosingEmitter(createAgentHarnessEmitter("pi", "chat", { onEvent: (event) => output.push(event) }, "run",
    "turn", "/workspace"), () => events.closeSegment());
  const events = new PiEvents(emit, { TEST_API_KEY: "fixture-secret-value" });
  return { output, events, emit };
}

describe("Pi bounded event projection", () => {
  it("correlates exact private tool IDs even when their redacted forms collide", () => {
    const f = fixture();
    const ids = ["fixture-secret-value", "[redacted]"];
    for (const toolCallId of ids) f.events.receive({ type: "tool_execution_start", toolCallId, toolName: "edit", args: { path: "fixture-secret-value" } });
    for (const toolCallId of [...ids].reverse()) f.events.receive({ type: "tool_execution_end", toolCallId, toolName: "edit", result: { content: [{ type: "text", text: "done" }] } });
    const activities = f.output.filter((event) => event.type === "activity");
    expect(activities).toHaveLength(4);
    expect(activities[0]!.activityId).toBe(activities[3]!.activityId);
    expect(activities[1]!.activityId).toBe(activities[2]!.activityId);
    expect(activities[0]!.activityId).not.toBe(activities[1]!.activityId);
    expect(JSON.stringify(f.output)).not.toContain("fixture-secret-value");
    expect(activities[0]!.activityId).toMatch(/^pi-tool:/u);
  });

  it("allows later native ID reuse while rejecting duplicate active and completed events", () => {
    const f = fixture();
    const start = { type: "tool_execution_start", toolCallId: "reused", toolName: "read" };
    const end = { type: "tool_execution_end", toolCallId: "reused", toolName: "read", isError: true };
    f.events.receive(start);
    expect(() => f.events.receive(start)).toThrow("invalid tool activity");
    f.events.receive(end);
    expect(() => f.events.receive(end)).toThrow("unknown or mismatched");
    f.events.receive(start); f.events.receive(end);
    const activities = f.output.filter((event) => event.type === "activity");
    expect(new Set(activities.map((event) => event.activityId)).size).toBe(2);
    expect(activities.filter((event) => event.phase === "failed")).toHaveLength(2);
  });

  it("rejects foreign tool completions and renamed tools without marking file mutations", () => {
    const f = fixture();
    f.events.receive({ type: "tool_execution_start", toolCallId: "read", toolName: "read" });
    for (const toolCallId of ["read", "foreign"]) {
      expect(() => f.events.receive({ type: "tool_execution_end", toolCallId, toolName: "write" })).toThrow("unknown or mismatched");
    }
    expect(f.output.some((event) => event.type === "activity" && event.fileMutation)).toBe(false);
  });

  it.each([true, false])("bounds Unicode reasoning with streamed=%s and preserves final-only reasoning", (streamed) => {
    const f = fixture();
    const text = `${"a".repeat(32_767)}🌿${"b".repeat(32_700)}fixture-secret-value`;
    f.events.receive({ type: "message_start", message: { role: "assistant" } });
    if (streamed) f.events.receive({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: text } });
    f.events.receive({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: text }] } });
    const chunks = f.output.flatMap((event) => event.type === "extension" && event.event.type === "reasoning-summary" ? [event.event.text] : []);
    expect(chunks.join("")).toBe(text.replace("fixture-secret-value", "[redacted]"));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(32_768);
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });
});

// T3 4ecbe5508 (#38334): Pi restarting a content block mid-stream.
type Output = AgentHarnessEvent[];
const update = (event: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: event });
const start = { type: "message_start", message: { role: "assistant" } };
const end = (content: unknown[] = []) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content } });

/**
 * The turn as the runtime lays it out: assistant segments and the tool activity between them, in order. A text
 * boundary or an activity closes the open segment; a segment snapshot replaces only the open one.
 */
function timeline(output: Output): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();
  let open = false;
  for (const event of output) {
    if (event.type === "text" || (event.type === "text-snapshot" && event.scope === "segment")) {
      if (!open) entries.push("");
      open = true;
      entries[entries.length - 1] = event.type === "text" ? `${entries.at(-1)}${event.text}` : event.text;
    } else if (event.type === "text-snapshot") throw new Error("Pi must not replace the whole turn's text.");
    else if (event.type === "text-boundary") open = false;
    else if (event.type === "extension" && ["approval", "input", "plan"].includes(event.event.type)) open = false;
    else if (event.type === "activity") {
      open = false;
      if (!event.activityId || !seen.has(event.activityId)) entries.push(`[${event.label}]`);
      if (event.activityId) seen.add(event.activityId);
    }
  }
  return entries.filter((entry) => entry !== "");
}

/** The open (latest) segment's text. */
function shownText(output: Output): string {
  return timeline(output).at(-1) ?? "";
}

function shownReasoning(output: Output): string {
  let shown = "";
  for (const event of output) {
    if (event.type !== "extension" || event.event.type !== "reasoning-summary") continue;
    shown = event.event.replace ? event.event.text : `${shown}${event.event.text}`;
  }
  return shown;
}

const snapshots = (output: Output) => output.filter((event) => event.type === "text-snapshot"
  || (event.type === "extension" && event.event.type === "reasoning-summary" && event.event.replace === true));

describe("Pi content blocks (T3 4ecbe5508)", () => {
  it("streams a normal text and thinking block by appending, without republishing", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "Plan " }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "the change." }));
    f.events.receive(update({ type: "thinking_end", contentIndex: 0, content: "Plan the change." }));
    f.events.receive(update({ type: "text_start", contentIndex: 1 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 1, delta: "Done " }));
    f.events.receive(update({ type: "text_delta", contentIndex: 1, delta: "already." }));
    f.events.receive(update({ type: "text_end", contentIndex: 1, content: "Done already." }));
    f.events.receive(end([{ type: "thinking", thinking: "Plan the change." }, { type: "text", text: "Done already." }]));
    f.events.finish();
    expect(snapshots(f.output)).toEqual([]);
    expect(shownReasoning(f.output)).toBe("Plan the change.");
    expect(shownText(f.output)).toBe("Done already.");
    expect(f.events.text.toString()).toBe("Done already.");
  });

  it("replaces only the restarted block's segment, keeping earlier messages and the tool between them in place", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Let me read the file." }));
    f.events.receive(end([{ type: "text", text: "Let me read the file." }]));
    f.events.receive({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } });
    f.events.receive({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [] } });
    f.events.receive(start);
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Abandoned attempt" }));
    expect(timeline(f.output)).toEqual(["Let me read the file.", "[read]", "Abandoned attempt"]);
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    expect(timeline(f.output)).toEqual(["Let me read the file.", "[read]"]);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Replacement attempt" }));
    f.events.receive(update({ type: "text_end", contentIndex: 0, content: "Replacement attempt" }));
    f.events.receive(end([{ type: "text", text: "Replacement attempt" }]));
    f.events.finish();
    expect(timeline(f.output)).toEqual(["Let me read the file.", "[read]", "Replacement attempt"]);
    expect(f.events.text.toString()).toBe("Let me read the file.\n\nReplacement attempt");
    expect(snapshots(f.output)).toEqual([expect.objectContaining({ type: "text-snapshot", scope: "segment", text: "" })]);
  });

  it("keeps messages apart while streaming and in the final text when a later message restarts", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "First answer." }));
    f.events.receive(end([{ type: "text", text: "First answer." }]));
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Abandoned" }));
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Replacement attempt" }));
    expect(timeline(f.output)).toEqual(["First answer.", "Replacement attempt"]);
    f.events.receive(end([{ type: "text", text: "Replacement attempt" }]));
    f.events.finish();
    expect(timeline(f.output)).toEqual(["First answer.", "Replacement attempt"]);
    expect(f.events.text.toString()).toBe("First answer.\n\nReplacement attempt");
  });

  it("keeps an answer Pi streams at an index it first used for thinking (an improvement over T3)", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "Considering." }));
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "The answer." }));
    f.events.receive(update({ type: "text_end", contentIndex: 0, content: "The answer." }));
    f.events.receive(end([{ type: "text", text: "The answer." }]));
    f.events.finish();
    expect(shownReasoning(f.output)).toBe("Considering.");
    expect(shownText(f.output)).toBe("The answer.");
    expect(f.events.text.toString()).toBe("The answer.");
  });

  it("replaces a thinking block Pi starts again, down to nothing when the last attempt is empty", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "Abandoned attempt" }));
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "Replacement attempt" }));
    expect(shownReasoning(f.output)).toBe("Replacement attempt");
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_end", contentIndex: 0 }));
    expect(shownReasoning(f.output)).toBe("");
    // A start after the block finished does not reopen it.
    f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "late" }));
    f.events.receive(end());
    f.events.finish();
    expect(shownReasoning(f.output)).toBe("");
  });

  it("keeps interleaved blocks in content order, and lets a finished block's content replace what streamed", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Hello " }));
    f.events.receive(update({ type: "text_delta", contentIndex: 2, delta: "world." }));
    f.events.receive(update({ type: "thinking_delta", contentIndex: 1, delta: "Hmm." }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "there, " }));
    expect(shownText(f.output)).toBe("Hello world.");
    f.events.receive(update({ type: "text_end", contentIndex: 0 }));
    expect(shownText(f.output)).toBe("Hello there, world.");
    f.events.receive(update({ type: "text_end", contentIndex: 2, content: "planet." }));
    f.events.receive(end());
    f.events.finish();
    expect(shownText(f.output)).toBe("Hello there, planet.");
    expect(f.events.text.toString()).toBe("Hello there, planet.");
    expect(shownReasoning(f.output)).toBe("Hmm.");
  });

  it("republishes interleaved blocks that never end when the run finishes", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 1, delta: "second" }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "first " }));
    f.events.finish();
    expect(shownText(f.output)).toBe("first second");
    expect(f.events.text.toString()).toBe("first second");
  });

  it("drops a secret prefix held back by an abandoned block and redacts final content", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Key fixture-sec" }));
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Clean " }));
    f.events.receive(update({ type: "text_end", contentIndex: 0, content: "Clean fixture-secret-value" }));
    f.events.receive(end());
    f.events.finish();
    expect(JSON.stringify(f.output)).not.toContain("fixture-sec");
    expect(shownText(f.output)).toBe("Clean [redacted]");
  });

  it.each([-1, 1.5, "0", 4096, Number.MAX_SAFE_INTEGER + 1])("refuses content index %s", (contentIndex) => {
    const f = fixture();
    f.events.receive(start);
    expect(() => f.events.receive(update({ type: "text_delta", contentIndex, delta: "x" }))).toThrow("invalid content block");
  });

  it("keeps text left before a mid-message activity in place when the block restarts", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Hello " }));
    f.emit.activity("tool", "completed", "Pi extension", { detail: "Indexing" });
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "wor" }));
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    expect(timeline(f.output)).toEqual(["Hello ", "[Pi extension]"]);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Hel" }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "lo world" }));
    f.events.receive(end([{ type: "text", text: "Hello world" }]));
    f.events.finish();
    expect(timeline(f.output)).toEqual(["Hello ", "[Pi extension]", "world"]);
    expect(f.events.text.toString()).toBe("Hello world");
  });

  it("shows a restarted block that differs from the text before a mid-message activity after it", () => {
    const f = fixture();
    f.events.receive(start);
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Hello " }));
    f.emit.rich({ type: "approval", request: { requestId: "a-1", kind: "command", title: "Run", detail: null } as never });
    f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "Goodbye." }));
    f.events.receive(end());
    f.events.finish();
    // The closed segment cannot change without moving text past the approval; the final text matches what streamed.
    expect(timeline(f.output)).toEqual(["Hello ", "Goodbye."]);
    // The final text keeps the two attempts apart, as the transcript does.
    expect(f.events.text.toString()).toBe("Hello \n\nGoodbye.");
  });

  it("caps what reasoning replacements emit, counting the whole run's reasoning each one carries", () => {
    const f = fixture();
    f.events.receive(start);
    for (let chunk = 0; chunk < 48; chunk += 1) {
      f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "r".repeat(64 * 1024) }));
    }
    f.events.receive(end());
    f.events.receive(start);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      f.events.receive(update({ type: "thinking_delta", contentIndex: 0, delta: "x" }));
      f.events.receive(update({ type: "thinking_start", contentIndex: 0 }));
    }
    f.events.finish();
    const replaced = snapshots(f.output).flatMap((event) => event.type === "extension" && event.event.type === "reasoning-summary"
      ? [event.event.text.length] : []);
    expect(replaced.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(64 * 1024 * 1024);
    // Each replacement carries the 3 MiB of earlier reasoning: 21 fit under 64 MiB, then reasoning keeps appending.
    expect(replaced).toHaveLength(21);
  });

  it("bounds the number of content blocks", () => {
    const blocks = fixture();
    blocks.events.receive(start);
    for (let index = 0; index < 1024; index += 1) {
      blocks.events.receive(update({ type: "thinking_delta", contentIndex: index, delta: "." }));
    }
    expect(() => blocks.events.receive(update({ type: "thinking_delta", contentIndex: 1024, delta: "." })))
      .toThrow("too many content blocks");
  });

  it("counts only the replaced segment toward the republish limit", () => {
    const f = fixture();
    f.events.receive(start);
    for (let chunk = 0; chunk < 48; chunk += 1) {
      f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "a".repeat(64 * 1024) }));
    }
    f.events.receive(end());
    f.events.receive(start);
    // The 3 MiB of the earlier message are not republished, so these never approach the limit.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "b" }));
      f.events.receive(update({ type: "text_start", contentIndex: 0 }));
    }
    expect(snapshots(f.output)).toHaveLength(40);
    expect(snapshots(f.output).every((event) => event.type === "text-snapshot" && event.text === "")).toBe(true);
    expect(timeline(f.output)).toHaveLength(1);
  });

  it("stops republishing past the limit and keeps appending instead of failing the run", () => {
    const f = fixture();
    f.events.receive(start);
    for (let chunk = 0; chunk < 32; chunk += 1) {
      f.events.receive(update({ type: "text_delta", contentIndex: 0, delta: "a".repeat(64 * 1024) }));
    }
    f.events.receive(update({ type: "text_end", contentIndex: 0 }));
    // Each restart of block 1 republishes block 0's 2 MiB segment; the 33rd would pass 64 MiB.
    for (let attempt = 0; attempt < 34; attempt += 1) {
      f.events.receive(update({ type: "text_delta", contentIndex: 1, delta: "b" }));
      f.events.receive(update({ type: "text_start", contentIndex: 1 }));
    }
    f.events.receive(update({ type: "text_delta", contentIndex: 1, delta: "end" }));
    f.events.receive(end());
    f.events.finish();
    expect(snapshots(f.output)).toHaveLength(32);
    expect(shownText(f.output).endsWith("bbend")).toBe(true);
    // The final text matches what streamed, abandoned attempts past the limit included.
    expect(f.events.text.toString()).toBe(`${"a".repeat(2 * 1024 * 1024)}bbend`);
  });
});
