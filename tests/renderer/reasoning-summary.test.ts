import { describe, expect, it } from "vitest";
import {
  latestReasoningLine,
  parseReasoningSummary,
} from "../../src/renderer/src/utils/reasoningSummary";

describe("latestReasoningLine", () => {
  it("shows the newest sentence and keeps its identity while it grows", () => {
    const early = latestReasoningLine("**Tracing ownership**\nReading the pane red");
    const grown = latestReasoningLine("**Tracing ownership**\nReading the pane reducer.");
    expect(early.text).toBe("Reading the pane red");
    expect(grown.text).toBe("Reading the pane reducer.");
    expect(grown.id).toBe(early.id);
  });

  it("gives a new sentence, line or heading a new identity", () => {
    const first = latestReasoningLine("**Tracing ownership**\nReading the pane reducer.");
    const sentence = latestReasoningLine("**Tracing ownership**\nReading the pane reducer. Checking");
    const heading = latestReasoningLine("**Tracing ownership**\nDone.**Testing drops**");
    expect(sentence.text).toBe("Checking");
    expect(sentence.id).not.toBe(first.id);
    expect(heading.text).toBe("Testing drops");
    expect(heading.id).not.toBe(first.id);
  });

  it("reads the last line of plain reasoning and tolerates empty content", () => {
    expect(latestReasoningLine("First line.\nSecond line now").text).toBe("Second line now");
    expect(latestReasoningLine("").text).toBe("");
  });
});

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
