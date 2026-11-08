import { describe, expect, it } from "vitest";
import { captureTranscriptPosition } from "../../src/renderer/src/components/response-timeline/row-lookup";

function transcript(scrollTop: number) {
  const scroll = document.createElement("div");
  const root = document.createElement("div");
  const row = document.createElement("div");
  row.dataset.responseRowId = "answer-row";
  row.getBoundingClientRect = () => ({ top: -200, bottom: 300 }) as DOMRect;
  root.append(row);
  scroll.append(root);
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  Object.defineProperties(scroll, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 1_000 },
    scrollTop: { value: scrollTop },
  });
  return { root, scroll };
}

describe("captureTranscriptPosition", () => {
  it("keeps a reader just above the latest content on their row", () => {
    const { root, scroll } = transcript(840);
    expect(captureTranscriptPosition(root, scroll, false)).toMatchObject({
      rowId: "answer-row",
      viewportOffset: -200,
      wasFollowing: false,
    });
    expect(captureTranscriptPosition(root, scroll, true)).toMatchObject({ rowId: null, wasFollowing: true });
    expect(captureTranscriptPosition(root, scroll)).toMatchObject({ rowId: null, wasFollowing: true });
  });

  it("keeps the row of a reader in reading mode even at the latest content", () => {
    const { root, scroll } = transcript(899);
    expect(captureTranscriptPosition(root, scroll, false)).toMatchObject({ rowId: "answer-row", wasFollowing: false });
    expect(captureTranscriptPosition(root, scroll)).toMatchObject({ rowId: null, wasFollowing: true });
  });

  it("does not trust a following mode for a reader far from the latest content", () => {
    const { root, scroll } = transcript(300);
    expect(captureTranscriptPosition(root, scroll, true)).toMatchObject({ rowId: "answer-row", wasFollowing: false });
  });
});
