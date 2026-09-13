// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import { CappedTextBuffer } from "../../src/server/codex/protocol";

describe.each([CappedProviderBuffer, CappedTextBuffer])("capped text buffer", (BufferType) => {
  it.each([
    { chunks: ["a🌙z"], limit: 2, expected: "a" },
    { chunks: ["a🌙", "z"], limit: 3, expected: "a🌙" },
    { chunks: ["a\ud83c", "\udf19z"], limit: 2, expected: "a" },
    { chunks: ["a", "🌙z"], limit: 2, expected: "a" },
  ])("truncates $chunks at $limit without splitting a code point", ({ chunks, limit, expected }) => {
    const buffer = new BufferType(limit);
    for (const chunk of chunks) buffer.append(chunk);
    expect(buffer.toString()).toBe(expected);
    expect(buffer.truncated).toBe(true);
    buffer.append("later");
    expect(buffer.toString()).toBe(expected);
  });

  it("retains an exactly fitting code point across chunks", () => {
    const buffer = new BufferType(3);
    buffer.append("a\ud83c"); buffer.append("\udf19");
    expect(buffer.toString()).toBe("a🌙");
    expect(buffer.truncated).toBe(false);
  });
});
