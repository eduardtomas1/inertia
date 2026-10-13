import { describe, expect, it } from "vitest";
import { MASCOT_LABELS } from "../../src/shared/mascot";

const NARROWEST_LABEL_SPACE = 120;
const DEJAVU_SANS_BOLD_12PX_CHARACTER = 7.5;

describe("mascot labels", () => {
  it("fit beside a pinned chat with the attention dot at 7.5 px per character, the DejaVu Sans Bold 12px fallback average", () => {
    const tooWide = Object.values(MASCOT_LABELS)
      .filter((label) => label.length * DEJAVU_SANS_BOLD_12PX_CHARACTER > NARROWEST_LABEL_SPACE);
    expect(tooWide).toEqual([]);
  });
});
