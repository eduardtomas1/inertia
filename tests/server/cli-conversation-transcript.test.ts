// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { EmptyCliTranscript, parseCliTranscript } from "../../src/server/cli-import/transcript";

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
  it("follows Claude's latest parent chain and omits sidechains, thinking and tools", () => {
    const result = parseCliTranscript(lines(claude("u1", null, "user", "Plan the import"), claude("a1", "u1", "assistant", [{ type: "thinking", thinking: "private" }]),
      claude("a2", "a1", "assistant", [{ type: "text", text: "Final" }]), claude("a3", "a2", "assistant", [{ type: "tool_use", name: "Read" }]),
      claude("abandoned", "a3", "user", "Abandoned branch"), claude("u2", "a3", "user", [{ type: "tool_result", content: "private" }, { type: "text", text: "Ship it" }]),
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
  it("redacts the opening exchange before it is populated", () => {
    const token = "sk-" + "b".repeat(40);
    const result = parseCliTranscript(lines(meta, codex("user", `Use ${token} and local-secret`), codex("assistant", "Authorization: Bearer opening-credential-value done")), "codex", date, ["local-secret"]);
    const serialized = JSON.stringify(result.opening);
    for (const secret of [token, "local-secret", "opening-credential-value"]) expect(serialized).not.toContain(secret);
    expect(result.opening.user).toContain("redacted");
    expect(result.opening.assistant).toContain("done");
  });
  it("bounds the opening exchange to 400 characters at a word boundary without an ellipsis", () => {
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" \n ");
    const result = parseCliTranscript(lines(meta, codex("user", words), codex("assistant", "y".repeat(500)), codex("user", "Later"), codex("assistant", "Later reply")), "codex", date);
    expect(result.opening.user.length).toBeLessThanOrEqual(400);
    expect(result.opening.user).toMatch(/^word0 word1 .* word\d+$/u);
    expect(words.replace(/\s+/gu, " ").startsWith(`${result.opening.user} `)).toBe(true);
    expect(result.opening.user).not.toMatch(/…|\.\.\.$/u);
    expect(result.opening.assistant).toBe("y".repeat(400));
  });
  it("keeps the first exchange even when older messages are omitted and reports a missing reply as null", () => {
    const long = parseCliTranscript(lines(meta, codex("user", "First request"), codex("assistant", "First reply"), ...Array.from({ length: 205 }, (_, index) => codex("user", `Message ${index}`))), "codex", date);
    expect(long.opening).toEqual({ user: "First request", assistant: "First reply" });
    expect(parseCliTranscript(lines(meta, codex("user", "Only a question")), "codex", date).opening).toEqual({ user: "Only a question", assistant: null });
  });
  it("bounds retained text, keeps recent messages and reports omissions", () => {
    const result = parseCliTranscript(lines(meta, ...Array.from({ length: 205 }, (_, index) => codex("user", `Message ${index}`))), "codex", date);
    expect(result.messages).toHaveLength(200);
    expect(result.messages.slice(0, 2).map(({ content }) => content)).toEqual(["Message 0", "Message 6"]);
    expect(result.messages.at(-1)?.content).toBe("Message 204");
    expect(result.omittedMessages).toBe(5);
    const large = parseCliTranscript(lines(meta, codex("user", "Start"), ...Array.from({ length: 20 }, () => codex("assistant", "x".repeat(40_000)))), "codex", date);
    expect(large.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0)).toBeLessThanOrEqual(256 * 1024);
    expect(large.messages.every((message) => message.content.length <= 32 * 1024)).toBe(true);
  });
  it("rejects mismatched session identities, non-native backends and missing workspace authority", () => {
    for (const payload of [{ ...meta.payload, id: "../../escape" }, { ...meta.payload, cwd: "" }, { ...meta.payload, model_provider: "custom" }]) {
      expect(() => parseCliTranscript(lines({ ...meta, payload }, codex("user", "Hello")), "codex", date)).toThrow();
    }
  });
  it("resumes the newest Claude session of a resumed transcript that starts with the earlier session's copied records", () => {
    const resumed = "01962fd7-9000-7000-8000-123456789abc";
    const result = parseCliTranscript(lines(claude("u1", null, "user", "Earlier request"), claude("a1", "u1", "assistant", "Earlier reply"),
      { ...claude("u2", "a1", "user", "Resumed request"), sessionId: resumed }, { ...claude("a2", "u2", "assistant", "Resumed reply"), sessionId: resumed }), "claude", date);
    expect(result.sessionId).toBe(resumed);
    expect(result.messages.map(({ content }) => content)).toEqual(["Earlier request", "Earlier reply", "Resumed request", "Resumed reply"]);
  });
  it("drops injected Codex context blocks and keeps real prose around them", () => {
    const result = parseCliTranscript(lines(meta,
      codex("user", "<recommended_plugins>\n- plugin\n</recommended_plugins>"),
      codex("user", "<codex_internal_context source=\"x\">state</codex_internal_context>\n<user_action>open</user_action>"),
      codex("user", "<in-app-browser-context>page</in-app-browser-context> <external_codex_apps_open_page>app</external_codex_apps_open_page>"),
      codex("user", "<environment_context><cwd>/workspace</cwd></environment_context>"),
      codex("user", "<user_action>clicked</user_action>\nFix the <b>bold</b> header"),
      codex("assistant", "Fixed it")), "codex", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Fix the <b>bold</b> header", "Fixed it"]);
    expect(result.title).toBe("Fix the <b>bold</b> header");
  });
  it("prefers what the Codex user typed over the injected response copy of the same turn", () => {
    const result = parseCliTranscript(lines(meta,
      codex("user", "<environment_context>ctx</environment_context>"),
      codex("user", "# AGENTS.md instructions for /workspace\n\nRules"),
      codex("user", "<recommended_plugins>p</recommended_plugins>\nShip the export"),
      { type: "event_msg", payload: { type: "user_message", message: "Ship the export" } },
      codex("assistant", "Shipped"),
      { type: "event_msg", payload: { type: "user_message", message: "" } },
      codex("assistant", "Image reviewed"),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }), "codex", date);
    expect(result.messages.map(({ role, content }) => [role, content])).toEqual([["user", "Ship the export"], ["assistant", "Shipped"]]);
  });
  it("drops Claude slash-command markup, reminders, notifications, interruptions, compact summaries and synthetic API errors", () => {
    const result = parseCliTranscript(lines(
      claude("u1", null, "user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      claude("u2", "u1", "user", "<local-command-stdout>cleared</local-command-stdout>"),
      claude("u3", "u2", "user", [{ type: "text", text: "<system-reminder>Be careful</system-reminder>" }]),
      claude("u4", "u3", "user", "<task-notification><status>done</status></task-notification>"),
      claude("u5", "u4", "user", "<system-reminder>context</system-reminder>\nReview the parser"),
      claude("a1", "u5", "assistant", [{ type: "text", text: "Reviewed" }]),
      { ...claude("a2", "a1", "assistant", [{ type: "text", text: "API Error: 500" }]), isApiErrorMessage: true },
      { ...claude("a3", "a2", "assistant", "Synthetic"), message: { role: "assistant", model: "<synthetic>", content: "Synthetic" } },
      claude("u6", "a3", "user", "[Request interrupted by user]"),
      { ...claude("u7", "u6", "user", "This session is being continued"), isCompactSummary: true },
      claude("u8", "u7", "user", "Thanks")), "claude", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Review the parser", "Reviewed", "Thanks"]);
    expect(result.title).toBe("Review the parser");
    expect(result.opening).toEqual({ user: "Review the parser", assistant: "Reviewed" });
  });
  it("follows a Claude compaction boundary back to the earlier history", () => {
    const result = parseCliTranscript(lines(
      claude("u1", null, "user", "Build the importer"), claude("a1", "u1", "assistant", "Built"),
      claude("u2", "a1", "user", "Add paging"), claude("a2", "u2", "assistant", "Paged"),
      { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a2", sessionId, cwd: "/workspace/project", timestamp: date },
      { ...claude("s1", "b1", "user", "This session is being continued from a previous conversation"), isCompactSummary: true },
      claude("u3", "s1", "user", "Now add tests"), claude("a3", "u3", "assistant", "Added")), "claude", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Build the importer", "Built", "Add paging", "Paged", "Now add tests", "Added"]);
    expect(result.title).toBe("Build the importer");
    expect(result.opening).toEqual({ user: "Build the importer", assistant: "Built" });
  });
  it("titles from the provider's own records first, then the first real prompt, and rejects transcripts without one", () => {
    const base = [claude("u1", null, "user", "First   real\nprompt"), claude("a1", "u1", "assistant", "Reply")];
    const named = (...records: unknown[]) => parseCliTranscript(lines(...base, ...records), "claude", date).title;
    const custom = { type: "custom-title", customTitle: "Renamed by me", sessionId };
    const generated = { type: "ai-title", aiTitle: "Generated title", sessionId };
    const summary = { type: "summary", summary: "Summary title", leafUuid: "a1" };
    expect(named(summary, generated, custom)).toBe("Renamed by me");
    expect(named(summary, generated)).toBe("Generated title");
    expect(named(summary)).toBe("Summary title");
    expect(named()).toBe("First real prompt");
    expect(named({ type: "custom-title", customTitle: "Uses sk-" + "c".repeat(40), sessionId })).toContain("redacted");
    expect(parseCliTranscript(lines(meta, codex("user", "Prompt"), { type: "event_msg", payload: { type: "thread_name_updated", thread_name: "Codex thread name" } }), "codex", date).title).toBe("Codex thread name");
    expect(() => parseCliTranscript(lines(meta, codex("user", "<user_action>x</user_action>"), codex("assistant", "Only the assistant spoke")), "codex", date)).toThrow(EmptyCliTranscript);
    expect(parseCliTranscript(lines(meta, codex("assistant", "\u0001\u0002"), codex("user", "Real")), "codex", date).messages.map(({ content }) => content)).toEqual(["Real"]);
  });
  it("cuts long titles at a word boundary", () => {
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const title = parseCliTranscript(lines(meta, codex("user", words)), "codex", date).title;
    expect(title.length).toBeLessThanOrEqual(160);
    expect(words.startsWith(`${title} `)).toBe(true);
  });
  it("unwraps Codex delegations to the delegated input and strips heartbeats", () => {
    const delegated = "<codex_delegation><source_thread_id>01962fd7-1000-7000-8000-000000000001</source_thread_id><input>Refactor the\n  export module</input><note>x</note></codex_delegation>";
    const result = parseCliTranscript(lines(meta,
      codex("user", "<heartbeat>tick</heartbeat>"),
      codex("user", delegated),
      codex("assistant", "Refactored"),
      codex("user", "<heartbeat interval=\"5\">tick</heartbeat>\nAnd the <code>tests</code>"),
      codex("user", "<codex_delegation><source_thread_id>x</source_thread_id></codex_delegation>")), "codex", date);
    expect(result.messages.map(({ role, content }) => [role, content])).toEqual([["user", "Refactor the\n  export module"], ["assistant", "Refactored"], ["user", "And the <code>tests</code>"]]);
    expect(result.title).toBe("Refactor the export module");
    expect(result.opening).toEqual({ user: "Refactor the export module", assistant: "Refactored" });
    const typed = parseCliTranscript(lines(meta, { type: "event_msg", payload: { type: "user_message", message: delegated } }, codex("assistant", "Done")), "codex", date);
    expect(typed.opening).toEqual({ user: "Refactor the export module", assistant: "Done" });
  });
  it("drops Codex AGENTS.md context that arrives after injected wrapper blocks in the same request", () => {
    const injected = { type: "response_item", timestamp: date, payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<recommended_plugins>\n- Example (example@curated)\n</recommended_plugins>" },
      { type: "input_text", text: "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>" },
      { type: "input_text", text: "<environment_context>\n  <cwd>/workspace/project</cwd>\n</environment_context>" },
    ] } };
    const result = parseCliTranscript(lines(meta, injected, codex("user", "Fix the sidebar"), codex("assistant", "Fixed")), "codex", date);
    expect(result.messages.map(({ role, content }) => [role, content])).toEqual([["user", "Fix the sidebar"], ["assistant", "Fixed"]]);
    expect(result.title).toBe("Fix the sidebar");
    expect(result.opening).toEqual({ user: "Fix the sidebar", assistant: "Fixed" });
  });
  it("unwraps any delegation wrapper that carries an input", () => {
    const result = parseCliTranscript(lines(meta,
      codex("user", "<realtime_delegation><session>voice</session><input>Summarise the call notes</input></realtime_delegation>"),
      codex("assistant", "Summarised"),
      codex("user", "<realtime_delegation><session>voice</session></realtime_delegation>")), "codex", date);
    expect(result.messages.map(({ content }) => content)).toEqual(["Summarise the call notes", "Summarised"]);
    expect(result.title).toBe("Summarise the call notes");
  });
  it("strips wrappers from assistant replies and drops replies that are only wrappers", () => {
    const codexResult = parseCliTranscript(lines(meta, codex("user", "Check in"), codex("assistant", "<heartbeat>tick</heartbeat>"),
      codex("assistant", "<heartbeat>tick</heartbeat>\nAll <b>good</b>")), "codex", date);
    expect(codexResult.messages.map(({ content }) => content)).toEqual(["Check in", "All <b>good</b>"]);
    expect(codexResult.opening).toEqual({ user: "Check in", assistant: "All <b>good</b>" });
    const claudeResult = parseCliTranscript(lines(claude("u1", null, "user", "Check in"), claude("a1", "u1", "assistant", [{ type: "text", text: "<heartbeat>tick</heartbeat>" }]),
      claude("a2", "a1", "assistant", [{ type: "text", text: "Done <system-reminder>x</system-reminder>" }])), "claude", date);
    expect(claudeResult.messages.map(({ content }) => content)).toEqual(["Check in", "Done"]);
  });
  it("keeps component markup in prose and code while still dropping injected blocks", () => {
    const fence = "```vue\n<my-card>Hello</my-card>\n<v-btn>Save</v-btn>\n```";
    const result = parseCliTranscript(lines(meta,
      codex("user", "<environment_context>ctx</environment_context>\nUse <router-link to=\"/\">Home</router-link> in my nav and `<my-card>x</my-card>`."),
      codex("assistant", "Write `<my-card>Hello</my-card>` then <v-btn>Save</v-btn>. <heartbeat>tick</heartbeat>"),
      codex("user", `Render this:\n${fence}`),
      codex("assistant", `<system-reminder>hidden</system-reminder>Here:\n${fence}`)), "codex", date);
    expect(result.messages.map(({ content }) => content)).toEqual([
      "Use <router-link to=\"/\">Home</router-link> in my nav and `<my-card>x</my-card>`.",
      "Write `<my-card>Hello</my-card>` then <v-btn>Save</v-btn>.",
      `Render this:\n${fence}`,
      `Here:\n${fence}`,
    ]);
  });
});
