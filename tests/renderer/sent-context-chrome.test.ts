import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const css = readSourceText(new URL("../../src/renderer/src/components/response-timeline/ConversationContextProvenance.css", import.meta.url));

describe("sent context chrome", () => {
  it("darkens the context button on hover and while open instead of repeating its resting fill", () => {
    expect(css).toMatch(/\.sent-context > span,\n\.sent-context > button \{[^}]*background: var\(--fill\);/u);
    expect(css).toMatch(/\.sent-context > button:hover,\n\.sent-context > button\[aria-expanded="true"\] \{\n  background: var\(--fill-strong\);\n\}/u);
  });
});
