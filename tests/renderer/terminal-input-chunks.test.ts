import { describe, expect, it } from "vitest";

import {
  TERMINAL_INPUT_CHUNK_CODE_UNITS,
  terminalInputChunks,
} from "../../src/renderer/src/utils/terminalInputChunks";

function expectUnicodeSafeChunks(input: string, expectedLengths: number[]): void {
  const chunks = terminalInputChunks(input);
  expect(chunks.map(({ length }) => length)).toEqual(expectedLengths);
  expect(chunks.join("")).toBe(input);
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(TERMINAL_INPUT_CHUNK_CODE_UNITS);
    expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/u);
  }
}

describe("terminal input chunking", () => {
  it("moves an astral character that straddles the exact 8,192-unit boundary", () => {
    expectUnicodeSafeChunks(`${"a".repeat(8_191)}😀b`, [8_191, 3]);
  });

  it("keeps a surrogate pair that ends exactly at the boundary", () => {
    expectUnicodeSafeChunks(`${"a".repeat(8_190)}😀b`, [8_192, 1]);
  });

  it("keeps a surrogate pair that starts exactly after the boundary", () => {
    expectUnicodeSafeChunks(`${"a".repeat(8_192)}😀`, [8_192, 2]);
  });

  it("preserves unpaired UTF-16 code units without exceeding the wire bound", () => {
    const input = `${"a".repeat(8_191)}\uD83D${"b".repeat(8_192)}`;
    const chunks = terminalInputChunks(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks.every(({ length }) => length <= 8_192)).toBe(true);
  });
});
