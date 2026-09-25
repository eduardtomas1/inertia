import { describe, expect, it } from "vitest";
import {
  advanceThinkingLine,
  IDLE_THINKING_LINE,
  parseReasoningSummary,
  readableReasoningLine,
  reasoningLineAt,
  reasoningLines,
  THINKING_LINE_MAX_DWELL_MS,
  THINKING_LINE_MIN_DWELL_MS,
  thinkingLineDwellMs,
  thinkingLineWakeAt,
  type ThinkingLineState,
} from "../../src/renderer/src/utils/reasoningSummary";

function step(
  state: ThinkingLineState,
  content: string,
  active: boolean,
  now: number,
): ThinkingLineState {
  return advanceThinkingLine(state, reasoningLines(content), {
    active,
    length: content.length,
    now,
  });
}

function shownText(state: ThinkingLineState, content: string): string | null {
  return state.offset === null
    ? null
    : reasoningLineAt(reasoningLines(content), state.offset)?.text ?? null;
}

describe("reasoningLines", () => {
  it("keeps a growing sentence at the same offset until it is finished", () => {
    const early = reasoningLines("**Tracing ownership**\nReading the pane red");
    const grown = reasoningLines("**Tracing ownership**\nReading the pane reducer.");
    expect(early).toEqual([
      { offset: 0, text: "Tracing ownership", complete: true },
      { offset: 22, text: "Reading the pane red", complete: false },
    ]);
    expect(grown[1]).toEqual({
      offset: 22,
      text: "Reading the pane reducer.",
      complete: true,
    });
  });

  it("finishes a sentence once the next one starts and leaves the live edge unfinished", () => {
    expect(reasoningLines("First sentence here. Second one is still")).toEqual([
      { offset: 0, text: "First sentence here.", complete: true },
      { offset: 21, text: "Second one is still", complete: false },
    ]);
  });

  it("gives an unclosed heading the offset it keeps once closed", () => {
    const open = reasoningLines("Done.\n\n**Checking the drop");
    const closed = reasoningLines("Done.\n\n**Checking the drop plans**");
    expect(open.at(-1)).toEqual({
      offset: 7,
      text: "Checking the drop",
      complete: false,
    });
    expect(closed).toEqual([
      { offset: 0, text: "Done.", complete: true },
      { offset: 7, text: "Checking the drop plans", complete: true },
    ]);
  });

  it("drops inline code marks and collapses whitespace", () => {
    expect(reasoningLines("Reading   `activity.tsx`  now.\n\n")).toEqual([
      { offset: 0, text: "Reading activity.tsx now.", complete: true },
    ]);
    expect(reasoningLines("")).toEqual([]);
  });
});

describe("readableReasoningLine", () => {
  const lines = reasoningLines("A one. B two. C thr");

  it("prefers the newest finished sentence over the live edge", () => {
    expect(readableReasoningLine(lines)).toEqual({
      offset: 7,
      text: "B two.",
      complete: true,
    });
  });

  it("falls back to the live edge only when nothing after the floor is finished", () => {
    expect(readableReasoningLine(lines, 14)?.text).toBe("C thr");
    expect(readableReasoningLine(lines, 20)).toBeNull();
  });
});

describe("thinkingLineDwellMs", () => {
  it("gives every line a reading time within bounds", () => {
    expect(thinkingLineDwellMs("Run tests.")).toBe(THINKING_LINE_MIN_DWELL_MS);
    expect(thinkingLineDwellMs("x".repeat(100))).toBe(4_500);
    expect(thinkingLineDwellMs("x".repeat(400))).toBe(THINKING_LINE_MAX_DWELL_MS);
  });
});

describe("advanceThinkingLine", () => {
  const first = "Reading the pane reducer. Check";
  const second = `${first}ing the drop plans. Then run`;

  it("shows the first readable line at once and holds it for its reading time", () => {
    const shown = step(IDLE_THINKING_LINE, first, true, 0);
    expect(shownText(shown, first)).toBe("Reading the pane reducer.");
    expect(shown.previousOffset).toBeNull();

    const waiting = step(shown, second, true, 1_000);
    expect(waiting).toBe(shown);
    expect(thinkingLineWakeAt(waiting, reasoningLines(second), true))
      .toBe(thinkingLineDwellMs("Reading the pane reducer."));

    const switched = step(waiting, second, true, thinkingLineDwellMs("Reading the pane reducer."));
    expect(shownText(switched, second)).toBe("Checking the drop plans.");
    expect(switched.previousOffset).toBe(0);
  });

  it("skips intermediate sentences instead of flashing them", () => {
    const shown = step(IDLE_THINKING_LINE, "One. Tw", true, 0);
    const content = "One. Two. Three. Four. Fi";
    const next = step(shown, content, true, THINKING_LINE_MIN_DWELL_MS);
    expect(shownText(next, content)).toBe("Four.");
  });

  it("never replaces a readable sentence with an unfinished fragment", () => {
    const shown = step(IDLE_THINKING_LINE, "Reading the pane reducer.", true, 0);
    const content = "Reading the pane reducer. Checking";
    expect(step(shown, content, true, 60_000)).toBe(shown);
    expect(thinkingLineWakeAt(shown, reasoningLines(content), true)).toBeNull();
  });

  it("keeps a line through a pause until it has been readable, then settles past it", () => {
    const shown = step(IDLE_THINKING_LINE, first, true, 0);
    const holding = step(shown, first, false, 1_000);
    expect(holding).toBe(shown);
    expect(thinkingLineWakeAt(holding, reasoningLines(first), false))
      .toBe(thinkingLineDwellMs("Reading the pane reducer."));

    const settled = step(holding, first, false, 2_400);
    expect(settled.offset).toBeNull();
    expect(settled.floor).toBe(first.length);

    const resumed = `${first}ed the logs.\n\nThe tests pass`;
    const next = step(settled, resumed, true, 9_000);
    expect(shownText(next, resumed)).toBe("The tests pass");
    expect(next.previousOffset).toBeNull();
  });

  it("continues the same reading pace when thinking resumes during a pause", () => {
    const shown = step(IDLE_THINKING_LINE, first, true, 0);
    const holding = step(shown, first, false, 500);
    const resumed = step(holding, second, true, 1_500);
    expect(resumed).toBe(shown);
    const switched = step(resumed, second, true, 2_400);
    expect(shownText(switched, second)).toBe("Checking the drop plans.");
  });

  it("resets a floor that no longer fits replaced content", () => {
    const state = { ...IDLE_THINKING_LINE, floor: 500 };
    const next = step(state, "Short reasoning.", true, 0);
    expect(shownText(next, "Short reasoning.")).toBe("Short reasoning.");
    expect(next.floor).toBe(0);
  });

  it("paces a fast token stream to reading speed", () => {
    const sentences = Array.from({ length: 30 }, (_, index) =>
      `Sentence ${index + 1} walks through the projection, the renderer store and the strip before deciding what to show next.`);
    const text = sentences.join(" ");
    let state = IDLE_THINKING_LINE;
    const switches: Array<{ at: number; text: string }> = [];
    for (let now = 0, length = 0; length < text.length; now += 330) {
      length = Math.min(text.length, length + 53);
      const content = text.slice(0, length);
      const before = state.offset;
      state = step(state, content, true, now);
      if (state.offset !== before) {
        switches.push({ at: now, text: shownText(state, content) ?? "" });
      }
    }
    expect(switches.length).toBeGreaterThanOrEqual(4);
    expect(switches.length).toBeLessThan(sentences.length / 4);
    for (let index = 1; index < switches.length; index += 1) {
      expect(switches[index]!.at - switches[index - 1]!.at)
        .toBeGreaterThanOrEqual(thinkingLineDwellMs(switches[index - 1]!.text));
      expect(switches[index]!.text).toMatch(/\.$/u);
    }
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
