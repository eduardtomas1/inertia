// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { createAgentHarnessEmitter, type AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { PiEvents } from "../../src/server/provider/pi-events";

function fixture() {
  const output: AgentHarnessEvent[] = [];
  const emit = createAgentHarnessEmitter("pi", "chat", { onEvent: (event) => output.push(event) }, "run", "turn", "/workspace");
  return { output, events: new PiEvents(emit, { TEST_API_KEY: "fixture-secret-value" }) };
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
