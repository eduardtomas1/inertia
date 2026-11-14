import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Highlight, paletteScore, rankPaletteItems } from "../../src/renderer/src/utils/paletteMatch";

describe("palette matching", () => {
  it("scores label prefixes above word prefixes above substrings", () => {
    expect(paletteScore("Code reviewer", "code-reviewer", "")).toBe(1);
    expect(paletteScore("Code reviewer", undefined, "code")).toBe(4);
    expect(paletteScore("Code reviewer", undefined, "rev")).toBe(3);
    expect(paletteScore("Code reviewer", undefined, "view")).toBe(2);
    expect(paletteScore("Code reviewer", "detail", "zzz")).toBe(0);
    expect(paletteScore("Open", "Settings", "sett")).toBe(3);
    expect(paletteScore("Open", undefined, "agent", "custom agents")).toBe(3);
  });

  it("ranks stably, honours the limit and keeps word matches as a last resort", () => {
    const items = [
      { id: "a", label: "Archive" },
      { id: "b", label: "Browse archive" },
      { id: "c", label: "Search chats" },
      { id: "d", label: "Unrelated" },
    ];
    expect(rankPaletteItems(items, "arch").map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(rankPaletteItems(items, " ARCH ", 1).map(({ id }) => id)).toEqual(["a"]);
    expect(rankPaletteItems(items, "arch", undefined, new Set(["d"])).map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
    expect(rankPaletteItems(items, "").map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
  });

  it("highlights every case-insensitive match and escapes the query", () => {
    const highlighted = Highlight({ text: "Review the reviewer", query: "rev" });
    expect(isValidElement(highlighted)).toBe(true);
    expect(renderToStaticMarkup(highlighted as ReactElement)).toBe("<mark>Rev</mark>iew the <mark>rev</mark>iewer");
    expect(renderToStaticMarkup(Highlight({ text: "a.b+c", query: ".b+" }) as ReactElement)).toBe("a<mark>.b+</mark>c");
    expect(Highlight({ text: "plain", query: "  " })).toBe("plain");
  });
});
