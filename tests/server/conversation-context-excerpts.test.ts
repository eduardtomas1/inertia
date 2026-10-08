import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { neutralizeUntrustedAgentText } from "../../src/server/runtime/untrusted-agent-text";

const corruption = vi.hoisted(() => ({ emptyContent: false }));
vi.mock("../../src/server/persistence/conversation-context-excerpts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/persistence/conversation-context-excerpts")>();
  return {
    ...actual,
    collectConversationContextExcerpts: (...args: Parameters<typeof actual.collectConversationContextExcerpts>) => {
      const collected = actual.collectConversationContextExcerpts(...args);
      return collected && corruption.emptyContent
        ? { ...collected, excerpts: collected.excerpts.map((excerpt) => ({ ...excerpt, content: "" })) }
        : collected;
    },
  };
});

const SHORTENED_MIDDLE = "…\n\n[middle of message omitted]\n\n";
const capturedAt = "2030-01-01T01:00:00.000Z";
const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-context-excerpts-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const databasePath = join(root, "runtime.sqlite");
  const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Excerpts", workspace);
  const source = store.createConversation(project.id, "Long answers", { activate: false });
  const target = store.createConversation(project.id, "Target", { activate: false });
  let second = 0;
  const at = () => new Date(Date.UTC(2030, 0, 1, 0, 0, second++)).toISOString();
  const say = (content: string, role: "user" | "assistant", createdAt = at()) =>
    store.createMessage(source.id, content, role, [], null, createdAt);
  const packet = () => store.contextPackets.create({
    sourceConversationId: source.id,
    targetConversationId: target.id,
    acknowledgedWorkspaceDifference: false,
  });
  const restored = (capacityBytes = 192 * 1024) => {
    const history = store.continuationHistory(source.id, capacityBytes, capturedAt)!;
    return {
      history,
      messages: history.blocks
        .map(({ content }) => JSON.parse(content) as { messages: Array<[string, string | number, unknown?]> })
        .flatMap(({ messages }) => messages)
        .filter(([author]) => author !== "gap"),
    };
  };
  const renameMessage = (from: string, to: string) => {
    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE messages SET id = ? WHERE id = ?").run(to, from);
    } finally {
      database.close();
    }
  };
  return { store, source, target, at, say, packet, restored, renameMessage };
}

function words(prefix: string, bytes: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const word = `${prefix}${index}${"x".repeat(index % 7)}`;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

function head(content: string): string {
  const at = content.indexOf(SHORTENED_MIDDLE);
  expect(at).toBeGreaterThan(0);
  return content.slice(0, at);
}

describe("conversation context excerpt bounds", () => {
  it("keeps a long final answer up to 32 KiB and cuts updates and requests at 8 KiB", () => {
    const f = fixture();
    const request = words("request", 12 * 1024);
    const update = words("update", 12 * 1024);
    const answer = words("answer", 24 * 1024);
    f.say(request, "user");
    f.say(update, "assistant");
    f.say(answer, "assistant");

    const excerpts = f.packet().excerpts;
    expect(excerpts.map(({ content }) => content.slice(0, 6))).toEqual(["reques", "update", "answer"]);
    expect(excerpts[2]).toMatchObject({ content: answer, truncated: false });
    for (const excerpt of excerpts.slice(0, 2)) {
      expect(excerpt.truncated).toBe(true);
      expect(Buffer.byteLength(excerpt.content)).toBeLessThanOrEqual(8 * 1024);
    }

    const { messages } = f.restored();
    expect(messages.map(([, text]) => text)).toContain(answer);
  });

  it("cuts a long answer only at the end of a whole word, ahead of the same marker", () => {
    const f = fixture();
    const request = words("ask", 10 * 1024);
    const answer = words("reply", 48 * 1024);
    f.say(request, "user");
    f.say(answer, "assistant");

    const [user, agent] = f.packet().excerpts;
    for (const [excerpt, original] of [[user!, request], [agent!, answer]] as const) {
      expect(excerpt.truncated).toBe(true);
      const kept = head(excerpt.content).replace(/…$/u, "");
      expect(original.startsWith(kept)).toBe(true);
      expect(original[kept.length]).toBe(" ");
    }
    expect(Buffer.byteLength(agent!.content)).toBeGreaterThan(24 * 1024);
    expect(Buffer.byteLength(agent!.content)).toBeLessThanOrEqual(32 * 1024);
  });

  it("keeps a heavily escaped final answer inside one transport block", () => {
    const f = fixture();
    f.say("Print the escaped paths.", "user");
    f.say("\"\\".repeat(16 * 1024), "assistant");

    const packet = f.packet();
    const { blocks } = f.store.contextPackets.materialize(f.target.id, [packet.id]);
    const sent = blocks.flatMap(({ content }) => (JSON.parse(content) as { messages: unknown[][] }).messages);
    expect(sent.map((entry) => entry[0])).toEqual(["user", "agent"]);
    const answer = packet.excerpts[1]!;
    expect(answer.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(answer.content))).toBeLessThanOrEqual(40 * 1024 + 2);
  });

  it.each([
    ["terminal colour codes", "\x1b[0m".repeat(9_000)],
    ["coloured lines", "\x1b[1m\x1b[31mE\x1b[0m\n".repeat(3_000)],
    ["control characters between words", "a\x01 ".repeat(12_000)],
    ["control characters only", "\x01\x02 ".repeat(12_000)],
  ])("keeps a bounded head of an answer dense with %s", (_name, answer) => {
    const f = fixture();
    f.say("Show the raw log.", "user");
    f.say(answer, "assistant");

    const packet = f.packet();
    const excerpt = packet.excerpts[1]!;
    expect(excerpt.content.length).toBeGreaterThan(1_000);
    expect(excerpt.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(excerpt.content))).toBeLessThanOrEqual(40 * 1024 + 2);
    expect(neutralizeUntrustedAgentText(excerpt.content)).toBe(excerpt.content);
    expect(f.store.contextPackets.get(packet.id, f.target.id).excerpts).toEqual(packet.excerpts);
    expect(f.store.contextPackets.list(f.target.id)).toHaveLength(1);
  });

  it("rejects an excerpt that would not read back before it stores the draft", () => {
    const f = fixture();
    f.say("Keep the retry limit at three.", "user");
    corruption.emptyContent = true;
    try {
      expect(() => f.packet()).toThrow("The saved chat context contains a malformed excerpt.");
    } finally {
      corruption.emptyContent = false;
    }
    expect(f.store.contextPackets.list(f.target.id)).toEqual([]);
    expect(f.packet().excerpts.map(({ content }) => content)).toEqual(["Keep the retry limit at three."]);
  });

  it("restores the newest turn with its long answer into a small custom-backend budget", () => {
    const f = fixture();
    for (let index = 0; index < 4; index += 1) {
      f.say(`Earlier request ${index}`, "user");
      f.say(`Earlier answer ${index}`, "assistant");
    }
    f.say("Write the patch.", "user");
    const code = Array.from({ length: 900 }, (_, index) =>
      `  const value${index} = "\\"quoted\\"" + map["key${index}"];`).join("\n");
    f.say(code, "assistant");

    const { history, messages } = f.restored(48 * 1024);
    const texts = messages.map(([, text]) => String(text));
    expect(texts).toContain("Write the patch.");
    expect(texts.some((text) => text.startsWith("const value0 = "))).toBe(true);
    expect(history.messageCount).toBeGreaterThanOrEqual(3);
  });
});

describe("conversation context message order", () => {
  it("keeps insertion order for messages created in the same millisecond", () => {
    const f = fixture();
    f.say("Chart the exports.", "user");
    const createdAt = f.at();
    const first = f.say("FIRST_INSERTED", "assistant", createdAt);
    const second = f.say("SECOND_INSERTED", "assistant", createdAt);
    f.renameMessage(first.id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    f.renameMessage(second.id, "00000000-0000-4000-8000-000000000000");

    const order = (texts: readonly unknown[]) => texts.filter((text) => String(text).endsWith("_INSERTED"));
    expect(order(f.packet().excerpts.map(({ content }) => content))).toEqual(["FIRST_INSERTED", "SECOND_INSERTED"]);
    expect(order(f.store.contextPackets.sourceTranscript(f.source.id, f.target.id).messages.map(({ content }) => content)))
      .toEqual(["FIRST_INSERTED", "SECOND_INSERTED"]);
    expect(order(f.restored().messages.map(([, text]) => text))).toEqual(["FIRST_INSERTED", "SECOND_INSERTED"]);
  });

  it("keeps the opening request in insertion order when two requests share a millisecond", () => {
    const f = fixture();
    const createdAt = f.at();
    const first = f.say("OPENING_REQUEST", "user", createdAt);
    const second = f.say("SECOND_REQUEST", "user", createdAt);
    f.renameMessage(first.id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    f.renameMessage(second.id, "00000000-0000-4000-8000-000000000000");
    for (let index = 0; index < 40; index += 1) {
      f.say(`Later request ${index} ${"detail ".repeat(400)}`, "user");
      f.say(`Later answer ${index} ${"detail ".repeat(400)}`, "assistant");
    }

    const { messages } = f.restored(32 * 1024);
    expect(messages[0]?.[1]).toBe("OPENING_REQUEST");
  });
});

describe("conversation context notes", () => {
  it("states that pages and earlier attachments are not available to the reader", () => {
    const f = fixture();
    f.store.createMessage(f.source.id, "Chart the exports.", "user", [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "exports.csv",
      path: "/private/tmp/exports.csv",
      mimeType: "text/csv",
      size: 2048,
    }], null, f.at());
    const turn = f.store.beginAgentTurn({
      id: "22222222-2222-4222-8222-222222222222",
      conversationId: f.source.id,
      runId: "33333333-3333-4333-8333-333333333333",
      content: "Draw it.",
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    f.store.htmlRenders.create({
      conversationId: f.source.id, runId: turn.turn.runId, turnId: turn.turn.id,
      title: "Exports by night", html: "<p>chart</p>", height: 320, createdAt: f.at(),
    });

    const packet = f.packet();
    expect(packet.excerpts.map(({ content }) => content))
      .toContain("[page: Exports by night] (rendered page; content not available here)");
    const { blocks } = f.store.contextPackets.materialize(f.target.id, [packet.id]);
    const format = (JSON.parse(blocks[0]!.content) as { format: string }).format;
    expect(format).toContain("attached files are named but not available here");
    expect(format).toContain("[page: title] is a rendered page whose content is not included");
    const restored = JSON.parse(f.restored().history.blocks[0]!.content) as { format: string };
    expect(restored.format).toBe(format);
  });
});
