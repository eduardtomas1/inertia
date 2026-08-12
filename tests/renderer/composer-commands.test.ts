import { describe, expect, it } from "vitest";

import { parseCompactComposerCommand } from "../../src/renderer/src/utils/composerCommands";

describe("compact composer command", () => {
  it("parses exact commands with optional multiline focus text", () => {
    expect(parseCompactComposerCommand("/compact")).toEqual({
      kind: "compact",
    });
    expect(parseCompactComposerCommand(
      "/COMPACT remember retrieval\nand its provider fixtures",
    )).toEqual({
      kind: "compact",
      instruction: "remember retrieval\nand its provider fixtures",
    });
  });

  it("does not consume ordinary prompts with a similar prefix", () => {
    expect(parseCompactComposerCommand("/compactness matters")).toBeNull();
    expect(parseCompactComposerCommand("please /compact this")).toBeNull();
  });
});
