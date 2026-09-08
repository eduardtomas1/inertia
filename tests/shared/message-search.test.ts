import { describe, expect, it } from "vitest";
import { clientCommandSchema } from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { messageSearchExcerpt, messageSearchPattern } from "../../src/shared/message-search";
import { messageSearchQuerySchema, messageSearchResultSchema } from "../../src/shared/message-search-schema";

const id = "11111111-1111-4111-8111-111111111111";
const hit = {
  projectId: id, conversationId: id, turnId: "legacy-turn-abc", messageId: id,
  role: "user", createdAt: "2026-09-07T10:00:00.000Z",
  snippet: "A literal [x]%_\\ match", matchStart: 10, matchEnd: 16,
};
const result = { kind: "conversation.messages.search", query: "[x]%_\\", hits: [hit], hasMore: false, incomplete: false };

describe("message search contract", () => {
  it("bounds queries and accepts migrated opaque turn identities", () => {
    expect(messageSearchQuerySchema.parse("  hello  ")).toBe("hello");
    for (const query of ["", " a ", "x".repeat(201), "a\0b"]) {
      expect(messageSearchQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(clientCommandSchema.safeParse({ type: "conversation.messages.search", requestId: id, payload: { query: "hello" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ type: "conversation.message.reveal", requestId: id, payload: { projectId: id, conversationId: id, turnId: hit.turnId, messageId: id } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ type: "conversation.message.reveal", requestId: id, payload: { projectId: id, conversationId: id, turnId: hit.turnId, messageId: id, focusDetached: "true" } }).success).toBe(false);
    expect(serverEventSchema.safeParse({ type: "request.result", requestId: id, result }).success).toBe(true);
  });

  it("rejects oversized, duplicate and malformed result payloads at the bridge", () => {
    for (const invalid of [
      { ...result, hits: Array.from({ length: 21 }, (_, index) => ({ ...hit, messageId: String(index) })) },
      { ...result, hits: [hit, hit] },
      { ...result, hits: [{ ...hit, snippet: "x".repeat(241) }] },
      { ...result, hits: [{ ...hit, matchEnd: 100 }] },
      { ...result, hits: [{ ...hit, role: "system" }] },
      { ...result, hits: [{ ...hit, conversationId: "other" }] },
      { ...result, unexpected: true },
      { ...result, hits: [{ ...hit, createdAt: "2026-02-30T10:00:00.000Z" }] },
    ]) {
      expect(messageSearchResultSchema.safeParse(invalid).success).toBe(false);
      expect(serverEventSchema.safeParse({ type: "request.result", requestId: id, result: invalid }).success).toBe(false);
    }
  });

  it.each(["[x]%_\\", "(a+)+$", "¿ÁRBOL?", "🐈 café", "./src/App.tsx"])("matches %s literally and case insensitively", (query) => {
    const content = `Some context ${query.toLocaleLowerCase()} more context`;
    const excerpt = messageSearchExcerpt(content, messageSearchPattern(query))!;
    expect(excerpt.snippet.slice(excerpt.matchStart, excerpt.matchEnd)).toBe(query.toLocaleLowerCase());
    expect(messageSearchExcerpt("unrelated text", messageSearchPattern(query))).toBeNull();
  });

  it.each([
    ["foo\nbar", "foo bar"],
    ["foo\tbar", "foo bar"],
    ["foo  bar", "foo bar"],
    ["Set **retry**", "Set retry"],
    ["Set `retry`", "Set retry"],
    ["See [details](https://example.test)", "See details"],
  ])("does not invent a literal %s match while formatting the preview", (content, query) => {
    expect(messageSearchExcerpt(content, messageSearchPattern(query))).toBeNull();
    const exactSource = messageSearchExcerpt(content, messageSearchPattern(content))!;
    expect(exactSource.snippet.slice(exactSource.matchStart, exactSource.matchEnd)).toBe(content);
  });

  it("shows readable Markdown and preserves explicit source searches", () => {
    const content = "### Recovery\n\nSet the **retry budget** to `three` attempts. [Details](https://example.test/retry).";
    const excerpt = messageSearchExcerpt(content, messageSearchPattern("retry budget"))!;
    expect(excerpt.snippet).toBe("Recovery Set the retry budget to three attempts. Details.");
    expect(excerpt.snippet.slice(excerpt.matchStart, excerpt.matchEnd)).toBe("retry budget");
    for (const query of ["**retry", "https://example.test/retry", "`three`"])
      expect(messageSearchExcerpt(content, messageSearchPattern(query))!.snippet).toContain(query);
  });

  it("keeps long malformed link markup searchable", () => {
    const content = "[".repeat(100_000) + "label](unterminated needle";
    const excerpt = messageSearchExcerpt(content, messageSearchPattern("needle"))!;
    expect(excerpt.snippet.slice(excerpt.matchStart, excerpt.matchEnd)).toBe("needle");
    expect(excerpt.snippet.length).toBeLessThanOrEqual(240);
  });

  it("keeps a maximum-length match and complete Unicode characters inside the snippet", () => {
    for (const prefix of ["", "z".repeat(81), "🐈".repeat(41)]) {
      const query = "🐈".repeat(100);
      const excerpt = messageSearchExcerpt(`${prefix}${query}${"🐈".repeat(50)}`, messageSearchPattern(query))!;
      expect(excerpt.snippet.length).toBeLessThanOrEqual(240);
      expect(excerpt.snippet.slice(excerpt.matchStart, excerpt.matchEnd)).toBe(query);
      expect(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(excerpt.snippet)).toBe(false);
    }
  });
});
