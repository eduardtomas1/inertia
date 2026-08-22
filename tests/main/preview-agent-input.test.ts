import { describe, expect, it } from "vitest";

import { hasUnguardedAgentPageContent } from "../../src/main/preview-agent-input";

const rootFrame = { frameTree: { frame: { id: "main" } } };

describe("agent Browser nested evidence boundary", () => {
  it("allows a valid top-level document with only Chromium-owned shadow roots", () => {
    expect(hasUnguardedAgentPageContent(rootFrame, {
      strings: ["user-agent"],
      documents: [{ nodes: { shadowRootType: { index: [2], value: [0] } } }],
    })).toBe(false);
  });

  it("fails closed for child frames and author-controlled shadow roots", () => {
    expect(hasUnguardedAgentPageContent({
      frameTree: {
        frame: { id: "main" },
        childFrames: [{ frame: { id: "child" } }],
      },
    }, {
      strings: [],
      documents: [{ nodes: {} }],
    })).toBe(true);
    for (const type of ["open", "closed"]) {
      expect(hasUnguardedAgentPageContent(rootFrame, {
        strings: [type],
        documents: [{ nodes: { shadowRootType: { index: [4], value: [0] } } }],
      })).toBe(true);
    }
  });

  it("fails closed when either debugger structure is malformed", () => {
    expect(hasUnguardedAgentPageContent({}, {})).toBe(true);
    expect(hasUnguardedAgentPageContent(rootFrame, {
      strings: ["open"],
      documents: [{ nodes: { shadowRootType: { index: [1], value: [] } } }],
    })).toBe(true);
  });
});
