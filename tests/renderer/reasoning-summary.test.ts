import { describe, expect, it } from "vitest";
import { parseReasoningSummary } from "../../src/renderer/src/utils/reasoningSummary";

describe("parseReasoningSummary", () => {
  it("splits concatenated bold headings", () => {
    const parsed = parseReasoningSummary(
      "**Clarifying network URLs and topology****Researching public_url usage in code****Expanding search scope across modules**",
    );
    expect(parsed.map(({ title }) => title)).toEqual([
      "Clarifying network URLs and topology",
      "Researching public_url usage in code",
      "Expanding search scope across modules",
    ]);
    expect(parsed.every(({ body }) => body === "")).toBe(true);
  });

  it("keeps body text with its heading", () => {
    const parsed = parseReasoningSummary("**First**\nDid a thing.\n**Second**\nThen another.");
    expect(parsed).toEqual([
      { id: "0", title: "First", body: "Did a thing." },
      { id: "1", title: "Second", body: "Then another." },
    ]);
  });

  it("returns nothing for unstructured text", () => {
    expect(parseReasoningSummary("just plain reasoning")).toEqual([]);
  });
});
