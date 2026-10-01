// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { parseCliTranscript } from "../../src/server/cli-import/transcript";

const sessionId = "01962fd7-1000-7000-8000-123456789abc";
const date = "2026-09-25T10:00:00.000Z";
const lines = (...items: unknown[]): string => items.map((item) => JSON.stringify(item)).join("\n");
const meta = { type: "session_meta", payload: { id: sessionId, cwd: "/workspace/project", model_provider: "openai" } };
const codex = (role: string, text: string) => ({ type: "response_item", timestamp: date, payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const claude = (uuid: string, parentUuid: string | null, type: string, content: unknown) => ({ uuid, parentUuid, type, sessionId, cwd: "/workspace/project", timestamp: date, message: { role: type, content } });

describe("native CLI transcript projection", () => {
  it("imports Codex visible text once, excludes scaffolding and tool output, and tolerates an unfinished final record", () => {
    const result = parseCliTranscript(lines(meta, codex("developer", "hidden instructions"), codex("user", "# AGENTS.md instructions for /workspace"),
      codex("user", "Fix the sidebar"), { type: "event_msg", payload: { type: "user_message", message: "Fix the sidebar" } },
      { type: "response_item", payload: { type: "function_call_output", output: "private output" } }, codex("assistant", "Fixed the sidebar")) + '\n{"type":', "codex", date);
    expect(result).toMatchObject({ sessionId, title: "Fix the sidebar", omittedMessages: 0 });
    expect(result.messages.map(({ content }) => content)).toEqual(["Fix the sidebar", "Fixed the sidebar"]);
    expect(() => parseCliTranscript(lines(meta) + '\n{broken\n' + lines(codex("user", "hello")), "codex", date)).toThrow(/unreadable/u);
  });
  it("honors Codex rollbacks so abandoned turns are not presented as current history", () => {
    const result = parseCliTranscript(lines(meta, codex("user", "Keep"), codex("assistant", "Kept"), codex("user", "Undo this"), codex("assistant", "Undone"),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }, codex("user", "Replacement")), "codex", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Keep", "Kept", "Replacement"]);
  });
  it("counts omitted image-only Codex requests when rolling back turns", () => {
    const imageRequest = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,ignored" }] } };
    const result = parseCliTranscript(lines(meta, codex("user", "Keep"), codex("assistant", "Kept"), imageRequest, codex("assistant", "Image analysis"),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }, codex("user", "Replacement")), "codex", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Keep", "Kept", "Replacement"]);
  });
  it("follows Claude's latest parent chain, deduplicates streamed messages, and omits sidechains, thinking and tools", () => {
    const result = parseCliTranscript(lines(claude("u1", null, "user", "Plan the import"), claude("a1", "u1", "assistant", [{ type: "text", text: "First" }]),
      claude("a1", "u1", "assistant", [{ type: "thinking", thinking: "private" }, { type: "text", text: "Final" }, { type: "tool_use", name: "Read" }]),
      claude("abandoned", "a1", "user", "Abandoned branch"), claude("u2", "a1", "user", [{ type: "tool_result", content: "private" }, { type: "text", text: "Ship it" }]),
      { ...claude("agent", "u2", "assistant", "Sidechain output"), isSidechain: true }), "claude", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Plan the import", "Final", "Ship it"]);
  });
  it("redacts credentials before titles or messages can reach persistence or the renderer", () => {
    const token = "sk-" + "a".repeat(40);
    const result = parseCliTranscript(lines(meta, codex("user", `Inspect ${token} and local-secret and https://alice:password@example.org/api`)), "codex", date, ["local-secret"]);
    const serialized = JSON.stringify(result);
    for (const secret of [token, "local-secret", "password"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("redacted");
  });
  it.each(["Bearer", "Basic"])("redacts the complete %s authorization header before import", (scheme) => {
    const credential = "cHJpdmF0ZS1pbXBvcnQtY3JlZGVudGlhbA==";
    const result = parseCliTranscript(lines(meta, codex("user", `Inspect Authorization: ${scheme} ${credential}`)), "codex", date);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.title).toContain("redacted");
  });
  it.each(['"Bearer', "'Basic"])("redacts an unterminated quoted authorization header (%s)", (scheme) => {
    const credential = "cHJpdmF0ZS1pbXBvcnQtY3JlZGVudGlhbA==";
    const result = parseCliTranscript(lines(meta, codex("user", `Inspect Authorization: ${scheme} ${credential}`)), "codex", date);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.title).toContain("redacted");
  });
  it("bounds retained text, keeps recent messages and reports omissions", () => {
    const result = parseCliTranscript(lines(meta, ...Array.from({ length: 205 }, (_, index) => codex("user", `Message ${index}`))), "codex", date);
    expect(result.messages).toHaveLength(200);
    expect(result.messages[0]?.content).toBe("Message 5");
    expect(result.omittedMessages).toBe(5);
    const large = parseCliTranscript(lines(meta, ...Array.from({ length: 20 }, () => codex("assistant", "x".repeat(40_000)))), "codex", date);
    expect(large.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0)).toBeLessThanOrEqual(256 * 1024);
    expect(large.messages.every((message) => message.content.length <= 32 * 1024)).toBe(true);
  });
  it("rejects mismatched session identities, non-native backends and missing workspace authority", () => {
    for (const payload of [{ ...meta.payload, id: "../../escape" }, { ...meta.payload, cwd: "" }, { ...meta.payload, model_provider: "custom" }]) {
      expect(() => parseCliTranscript(lines({ ...meta, payload }, codex("user", "Hello")), "codex", date)).toThrow();
    }
    expect(() => parseCliTranscript(lines(claude("u1", null, "user", "Hello"), { ...claude("a1", "u1", "assistant", "No"), sessionId: "different" }), "claude", date)).toThrow(/identity/u);
  });
});
