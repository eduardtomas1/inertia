import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { libraryCoherent } from "../../src/shared/contracts/server-event-discriminants";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  MAX_LIBRARY_CATEGORIES,
  MAX_LIBRARY_CATEGORY_NAME_CHARS,
  MAX_LIBRARY_SERIALIZED_BYTES,
  MAX_SAVED_ANSWER_EXCERPT_CHARS,
  MAX_SAVED_ANSWER_TITLE_CHARS,
  SAVED_ANSWER_FALLBACK_TITLE,
  libraryPagesSchema,
  savedAnswerDefaultTitle,
  savedAnswerExcerpt,
  truncateLibraryText,
  type LibraryCategory,
  type LibraryPage,
  type SavedAnswer,
} from "../../src/shared/library";

const ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const OTHER_CATEGORY = "33333333-3333-4333-8333-333333333333";
const ANSWER = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-03T10:00:00.000Z";

function category(overrides: Partial<LibraryCategory> = {}): LibraryCategory {
  return { id: CATEGORY, name: "Recipes", createdAt: NOW, updatedAt: NOW, ...overrides };
}

function answer(overrides: Partial<SavedAnswer> = {}): SavedAnswer {
  return {
    id: ANSWER,
    conversationId: "chat-1",
    projectId: "project-1",
    turnId: "turn-1",
    messageId: "message-1",
    categoryId: CATEGORY,
    title: "How do I bake bread?",
    excerpt: "Mix flour and water.",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function page(overrides: Partial<LibraryPage> = {}): LibraryPage {
  return {
    renderId: ID,
    title: "Chart",
    height: 360,
    conversationId: "chat-1",
    conversationTitle: "Charts",
    projectId: "project-1",
    turnId: "turn-1",
    messageId: "message-2",
    createdAt: NOW,
    archived: false,
    ...overrides,
  };
}

describe("library text derivation", () => {
  it("takes the first non-empty request line, stripped of markdown and collapsed", () => {
    expect(savedAnswerDefaultTitle("\n\n  ## **Fix**   the `build`  \nSecond line")).toBe("Fix the build");
    expect(savedAnswerDefaultTitle("> - [ ] Read [the docs](https://example.com) ~~now~~\n")).toBe("Read the docs now");
    expect(savedAnswerDefaultTitle("```ts\nconst snake_case_name = 1;\n```")).toBe("const snake_case_name = 1;");
    expect(savedAnswerDefaultTitle("1. *First* _step_ | next")).toBe("First step next");
  });

  it("falls back to the answer and then a fixed title when the request has no text", () => {
    expect(savedAnswerDefaultTitle("  \n---\n", "# Answer heading\nBody")).toBe("Answer heading");
    expect(savedAnswerDefaultTitle("", "")).toBe(SAVED_ANSWER_FALLBACK_TITLE);
  });

  it("truncates titles and excerpts with an ellipsis inside their bounds", () => {
    const title = savedAnswerDefaultTitle("word ".repeat(100));
    expect(title.length).toBeLessThanOrEqual(MAX_SAVED_ANSWER_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
    const excerpt = savedAnswerExcerpt(`# Result\n\n- **one**\n- two\n\n${"x ".repeat(300)}`);
    expect(excerpt.startsWith("Result one two x x")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_SAVED_ANSWER_EXCERPT_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/[\r\n]/u);
    expect(savedAnswerExcerpt("Short *answer*.")).toBe("Short answer.");
    expect(savedAnswerExcerpt("")).toBe("");
  });

  it("normalises hostile markdown in bounded time", () => {
    const hostile = ["__a ", "**a ", "`", "``a ", " ", "[](", "<a", "*a ", "- ", "| "]
      .map((unit) => unit.repeat(Math.ceil(16 * 1_024 / unit.length)));
    hostile.push("x\n".repeat(8 * 1_024), `${" ".repeat(16 * 1_024)}x`);
    for (const input of hostile) {
      const started = performance.now();
      const excerpt = savedAnswerExcerpt(input);
      const title = savedAnswerDefaultTitle(input, input);
      expect(performance.now() - started).toBeLessThan(50);
      expect(excerpt.length).toBeLessThanOrEqual(MAX_SAVED_ANSWER_EXCERPT_CHARS);
      expect(title.length).toBeLessThanOrEqual(MAX_SAVED_ANSWER_TITLE_CHARS);
    }
    expect(savedAnswerExcerpt("__a ".repeat(4_096)).startsWith("__a __a")).toBe(true);
    expect(savedAnswerExcerpt("**bold** and __strong__ with `code` and ``a b``")).toBe("bold and strong with code and a b");
  });

  it("stops reading the answer once the excerpt is full", () => {
    const excerpt = savedAnswerExcerpt(`${"word ".repeat(60)}\n${"later ".repeat(60)}`);
    expect(excerpt.startsWith("word word")).toBe(true);
    expect(excerpt).not.toContain("later");
    expect(excerpt.length).toBeLessThanOrEqual(MAX_SAVED_ANSWER_EXCERPT_CHARS);
  });

  it("never splits a surrogate pair when truncating", () => {
    const text = `${"a".repeat(8)}😀tail`;
    const truncated = truncateLibraryText(text, 10);
    expect(truncated).toBe(`${"a".repeat(8)}…`);
    expect(truncated.length).toBeLessThanOrEqual(10);
  });
});

describe("library command contracts", () => {
  const command = (type: string, payload: unknown) => clientCommandSchema.safeParse({ type, requestId: ID, payload });

  it("validates category commands", () => {
    expect(command("library.category.create", { name: "  Recipes " }).success).toBe(true);
    expect(command("library.category.create", { name: "   " }).success).toBe(false);
    expect(command("library.category.create", { name: "x".repeat(MAX_LIBRARY_CATEGORY_NAME_CHARS + 1) }).success).toBe(false);
    expect(command("library.category.create", { name: "Two\nlines" }).success).toBe(false);
    expect(command("library.category.create", { name: "Recipes", id: ID }).success).toBe(false);
    expect(command("library.category.rename", { categoryId: CATEGORY, name: "Bread" }).success).toBe(true);
    expect(command("library.category.rename", { categoryId: "category-1", name: "Bread" }).success).toBe(false);
    expect(command("library.category.delete", { categoryId: CATEGORY }).success).toBe(true);
    expect(command("library.category.delete", {}).success).toBe(false);
  });

  it("validates saved answer commands and the pages read", () => {
    const save = { conversationId: "chat-1", turnId: "turn-1", messageId: "message-1", categoryId: null };
    expect(command("library.answer.save", save).success).toBe(true);
    expect(command("library.answer.save", { ...save, categoryId: CATEGORY, title: "Bread" }).success).toBe(true);
    expect(command("library.answer.save", { ...save, categoryId: undefined }).success).toBe(false);
    expect(command("library.answer.save", { ...save, title: "" }).success).toBe(false);
    expect(command("library.answer.save", { ...save, title: "x".repeat(MAX_SAVED_ANSWER_TITLE_CHARS + 1) }).success).toBe(false);
    expect(command("library.answer.save", { ...save, messageId: "" }).success).toBe(false);
    expect(command("library.answer.update", { savedAnswerId: ANSWER, categoryId: null }).success).toBe(true);
    expect(command("library.answer.update", { savedAnswerId: ANSWER, title: "Renamed" }).success).toBe(true);
    expect(command("library.answer.update", { savedAnswerId: ANSWER }).success).toBe(false);
    expect(command("library.answer.update", { savedAnswerId: ANSWER, excerpt: "x" }).success).toBe(false);
    expect(command("library.answer.remove", { savedAnswerId: ANSWER }).success).toBe(true);
    expect(command("library.answer.remove", { savedAnswerId: "answer-1" }).success).toBe(false);
    expect(command("library.pages.list", {}).success).toBe(true);
    expect(command("library.pages.list", { limit: 5 }).success).toBe(false);
  });
});

describe("library event coherence", () => {
  const libraryUpdated = (library: unknown) => parseServerEvent({
    type: "runtime.event",
    sync: { runtimeGeneration: "runtime-1", latestSequence: 1 },
    scope: { kind: "shell" },
    event: { type: "library.updated", library },
  });

  it("accepts a coherent library and rejects incoherent ones", () => {
    expect(libraryUpdated({ categories: [category()], savedAnswers: [answer()] })).toBeTruthy();
    expect(libraryUpdated({ categories: [], savedAnswers: [answer({ categoryId: null })] })).toBeTruthy();
    for (const invalid of [
      { categories: [category()] },
      { categories: [category(), category()], savedAnswers: [] },
      { categories: [category(), category({ id: OTHER_CATEGORY, name: "RECIPES" })], savedAnswers: [] },
      { categories: [], savedAnswers: [answer()] },
      { categories: [category()], savedAnswers: [answer(), answer({ id: ID })] },
      { categories: [category()], savedAnswers: [answer({ excerpt: "x".repeat(MAX_SAVED_ANSWER_EXCERPT_CHARS + 1) })] },
      { categories: Array.from({ length: MAX_LIBRARY_CATEGORIES + 1 }, (_, index) =>
        category({ id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`, name: `C${index}` })), savedAnswers: [] },
      { categories: [{ ...category(), extra: true }], savedAnswers: [] },
    ]) expect(() => libraryUpdated(invalid)).toThrow("Malformed server event");
    const large = Array.from({ length: 600 }, (_, index) => answer({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      messageId: `message-${index}`,
      categoryId: null,
      title: "\u0001".repeat(120),
      excerpt: "\u0001".repeat(200),
    }));
    expect(() => libraryUpdated({ categories: [], savedAnswers: large })).toThrow("Malformed server event");
    expect(libraryUpdated({ categories: [], savedAnswers: large.slice(0, 300) })).toBeTruthy();
    expect(MAX_LIBRARY_SERIALIZED_BYTES).toBe(1_024 * 1_024);
  });

  it("checks saved answers against the snapshot's conversations", () => {
    const projects = new Map([["chat-1", "project-1"]]);
    expect(libraryCoherent(undefined, projects)).toBe(true);
    expect(libraryCoherent({ categories: [category()], savedAnswers: [answer()] }, projects)).toBe(true);
    expect(libraryCoherent({ categories: [category()], savedAnswers: [answer({ projectId: "project-2" })] }, projects)).toBe(false);
    expect(libraryCoherent({ categories: [category()], savedAnswers: [answer({ conversationId: "chat-2" })] }, projects)).toBe(false);
  });

  it("validates library request results without accepting page HTML", () => {
    const result = (value: Record<string, unknown>) => parseServerEvent({ type: "request.result", requestId: ID, result: value });
    expect(result({ kind: "library.category", category: category() })).toBeTruthy();
    expect(result({ kind: "library.answer", savedAnswer: answer() })).toBeTruthy();
    expect(result({ kind: "library.pages", pages: [page(), page({ renderId: ANSWER, height: null, messageId: null })] })).toBeTruthy();
    expect(() => result({ kind: "library.pages", pages: [page(), page()] })).toThrow("Malformed server event");
    expect(() => result({ kind: "library.pages", pages: [{ ...page(), html: "<p>secret</p>" }] })).toThrow("Malformed server event");
    expect(() => result({ kind: "library.answer", savedAnswer: { ...answer(), title: "" } })).toThrow("Malformed server event");
    expect(libraryPagesSchema.safeParse(Array.from({ length: 501 }, () => page())).success).toBe(false);
  });
});
