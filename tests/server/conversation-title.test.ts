import { describe, expect, it } from "vitest";

import {
  isUntitledConversationTitle,
  normalizeGeneratedTitle,
  quickConversationTitle,
} from "../../src/server/runtime/conversation-title";

describe("quick conversation titles", () => {
  it.each([
    ["Fix the login redirect loop", "Fix the login redirect loop"],
    ["Please fix the flaky upload test in the settings page today", "Please fix the flaky upload test"],
    ["Please fix this:\n\n- first issue\r\n- second issue", "Please fix this"],
    ["\n\n   \n  Second line wins\nthird", "Second line wins"],
    ["$review check the parser changes", "check the parser changes"],
    ["Use $HOME and $5 in the script", "Use $HOME and $5 in the"],
    ["Run \\$review literally", "Run \\$review literally"],
    ["```ts\nconst a = 1;\n```\nWhy does this fail", "Why does this fail"],
    ["~~~\nlog output\n~~~\nExplain the log", "Explain the log"],
    ["Why does `parseConfig()` crash on empty input", "Why does crash on empty input"],
    ["See https://example.com/a?b=c for details", "See for details"],
    ["Look at\thttp://x.test/path    please", "Look at please"],
    ["Summarize   the\u0007 report", "Summarize the report"],
  ])("derives %j as %j", (content, title) => {
    expect(quickConversationTitle(content)).toBe(title);
  });

  it.each([
    "",
    "   \n\t",
    "```\nonly code\n```",
    "https://example.com/only",
    "`only inline code`",
    "$review",
  ])("returns an empty title for %j", (content) => {
    expect(quickConversationTitle(content)).toBe("");
  });

  it("keeps at most 60 characters at a word boundary", () => {
    const title = quickConversationTitle(
      "Internationalization configuration troubleshooting documentation walkthrough",
    );
    expect(title).toBe("Internationalization configuration troubleshooting");
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("cuts a single long word at a complete character", () => {
    expect(quickConversationTitle("a".repeat(59) + "🌍" + "tail"))
      .toBe("a".repeat(59) + "🌍");
    expect(quickConversationTitle("b".repeat(59) + "👩‍👩‍👧‍👦" + "tail"))
      .toBe("b".repeat(59) + "👩‍👩‍👧‍👦");
  });

  it("keeps non-Latin words", () => {
    expect(quickConversationTitle("Исправь ошибку входа в систему пожалуйста сегодня"))
      .toBe("Исправь ошибку входа в систему пожалуйста");
    expect(quickConversationTitle("修复登录问题")).toBe("修复登录问题");
  });

  it("depends only on the leading part of very long content", () => {
    const prefix = "Explain the failing build\n";
    expect(quickConversationTitle(prefix + "x".repeat(100_000)))
      .toBe("Explain the failing build");
    expect(quickConversationTitle("```\n" + "x".repeat(20_000) + "\n```\nAfter the fence"))
      .toBe("");
  });
});

describe("generated title normalization", () => {
  it.each([
    ["Login redirect loop fix", "Login redirect loop fix"],
    ["\"Login redirect loop fix\"", "Login redirect loop fix"],
    ["`parser.ts` crash investigation.", "parser.ts crash investigation"],
    ["“Upload test flake”", "Upload test flake"],
    ["<think>The user wants a title</think>\nRate limit backoff", "Rate limit backoff"],
    ["<analysis>\nthinking\n</analysis>Settings page layout", "Settings page layout"],
    ["```\nCI cache warmup\n```", "CI cache warmup"],
    ["\n\n  Database   migration   review  \nsecond line", "Database migration review"],
    ["One two three four five six seven eight", "One two three four five six"],
  ])("normalizes %j as %j", (text, title) => {
    expect(normalizeGeneratedTitle(text)).toBe(title);
  });

  it.each([
    "",
    "   ",
    "New chat",
    "new thread.",
    "\"Untitled\"",
    "Chat",
    "Conversation",
    "<think>only thinking</think>",
    "```\n```",
  ])("rejects %j", (text) => {
    expect(normalizeGeneratedTitle(text)).toBeUndefined();
  });

  it("caps a generated title at 60 characters", () => {
    const title = normalizeGeneratedTitle(
      "Internationalization configuration troubleshooting documentation",
    );
    expect(title).toBe("Internationalization configuration troubleshooting");
  });
});

describe("untitled conversation titles", () => {
  it.each([
    ["New chat", true],
    ["New thread", true],
    ["new chat", false],
    ["New chat about tests", false],
    ["", false],
  ])("treats %j as untitled: %s", (title, untitled) => {
    expect(isUntitledConversationTitle(title)).toBe(untitled);
  });
});
