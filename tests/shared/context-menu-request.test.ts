import { describe, expect, it } from "vitest";

import { parseContextMenuRequest } from "../../src/shared/context-menu";

const conversationId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const anchor = { x: 12.5, y: 40 };

const valid = {
  message: { kind: "message", conversationId, role: "assistant", hasSelection: false, anchor },
  code: { kind: "code", conversationId, hasSelection: true, anchor },
  codeWithoutConversation: { kind: "code", hasSelection: false, anchor },
  projectLink: { kind: "project-link", projectId, conversationId, relativePath: "src/index.ts", anchor },
  diffFile: { kind: "diff-file", projectId, relativePath: "docs/a b.md", anchor },
  file: { kind: "file", projectId, conversationId, relativePath: "src", directory: true, anchor },
  terminal: { kind: "terminal", hasSelection: false, clearable: true, anchor },
};

describe("context menu requests", () => {
  it.each(Object.entries(valid))("accepts a well-formed %s request", (_name, request) => {
    expect(parseContextMenuRequest(request)).toEqual(request);
  });

  it("returns a copy that drops nothing and adds nothing", () => {
    const parsed = parseContextMenuRequest(valid.file);
    expect(parsed).not.toBe(valid.file);
    expect(Object.keys(parsed!).sort()).toEqual(Object.keys(valid.file).sort());
  });

  it.each([
    ["no object", null],
    ["an array", [valid.message]],
    ["an unknown kind", { ...valid.terminal, kind: "selection" }],
    ["an extra key", { ...valid.terminal, text: "secret" }],
    ["message content", { ...valid.message, content: "hello" }],
    ["a missing flag", { kind: "terminal", hasSelection: false, anchor }],
    ["a string flag", { ...valid.terminal, hasSelection: "true" }],
    ["a message without a conversation", { ...valid.message, conversationId: undefined }],
    ["a message id", { ...valid.message, messageId: "22222222-2222-4222-8222-222222222222" }],
    ["a system message", { ...valid.message, role: "system" }],
    ["a malformed conversation id", { ...valid.code, conversationId: "../other" }],
    ["a conversation on a terminal", { ...valid.terminal, conversationId }],
    ["a malformed project id", { ...valid.diffFile, projectId: "project" }],
    ["an absolute path", { ...valid.diffFile, relativePath: "/etc/passwd" }],
    ["a Windows drive path", { ...valid.diffFile, relativePath: "C:\\Windows" }],
    ["a parent traversal", { ...valid.projectLink, relativePath: "src/../../secret" }],
    ["an empty path", { ...valid.file, relativePath: "" }],
    ["a path with a newline", { ...valid.file, relativePath: "a\nb" }],
    ["an over-long path", { ...valid.file, relativePath: "a".repeat(4_097) }],
    ["a directory flag on a link", { ...valid.projectLink, directory: false }],
    ["a missing anchor", { kind: "code", hasSelection: false }],
    ["a negative anchor", { ...valid.code, anchor: { x: -1, y: 0 } }],
    ["an infinite anchor", { ...valid.code, anchor: { x: Number.POSITIVE_INFINITY, y: 0 } }],
    ["a NaN anchor", { ...valid.code, anchor: { x: Number.NaN, y: 0 } }],
    ["a huge anchor", { ...valid.code, anchor: { x: 100_001, y: 0 } }],
    ["an anchor with extra keys", { ...valid.code, anchor: { x: 1, y: 1, width: 3 } }],
    ["a string anchor coordinate", { ...valid.code, anchor: { x: "1", y: 1 } }],
  ])("rejects %s", (_name, request) => {
    expect(parseContextMenuRequest(request)).toBeNull();
  });

  it("rejects objects with a non-plain prototype", () => {
    const request = Object.assign(Object.create({ inherited: true }), valid.terminal);
    expect(parseContextMenuRequest(request)).toBeNull();
  });
});
