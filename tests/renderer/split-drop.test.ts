import { describe, expect, it } from "vitest";

import {
  persistSplitOrientation,
  readSplitOrientation,
  SPLIT_ORIENTATION_STORAGE_KEY,
  splitDropArrangement,
  splitDropRect,
  splitDropZone,
} from "../../src/renderer/src/utils/splitConversation";

const workspace = { left: 100, top: 50, width: 800, height: 400 };

describe("split drop zones", () => {
  it("picks the workspace edge nearest to the pointer", () => {
    expect(splitDropZone(workspace, 120, 250, false)).toBe("left");
    expect(splitDropZone(workspace, 880, 250, false)).toBe("right");
    expect(splitDropZone(workspace, 500, 60, false)).toBe("top");
    expect(splitDropZone(workspace, 500, 440, false)).toBe("bottom");
    expect(splitDropZone(workspace, 300, 100, false)).toBe("top");
    expect(splitDropZone(workspace, 150, 200, false)).toBe("left");
  });

  it("offers only top and bottom while the split is forced to stack", () => {
    expect(splitDropZone(workspace, 120, 100, true)).toBe("top");
    expect(splitDropZone(workspace, 880, 400, true)).toBe("bottom");
  });

  it("ignores points outside the workspace and empty workspaces", () => {
    expect(splitDropZone(workspace, 99, 250, false)).toBeNull();
    expect(splitDropZone(workspace, 500, 451, false)).toBeNull();
    expect(splitDropZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, false))
      .toBeNull();
  });

  it("highlights the half of the workspace the chat will take", () => {
    expect(splitDropRect(workspace, "left"))
      .toEqual({ left: 100, top: 50, width: 400, height: 400 });
    expect(splitDropRect(workspace, "right"))
      .toEqual({ left: 500, top: 50, width: 400, height: 400 });
    expect(splitDropRect(workspace, "top"))
      .toEqual({ left: 100, top: 50, width: 800, height: 200 });
    expect(splitDropRect(workspace, "bottom"))
      .toEqual({ left: 100, top: 250, width: 800, height: 200 });
  });

  it("places the dropped chat on the chosen side", () => {
    expect(splitDropArrangement("left", false))
      .toEqual({ orientation: "columns", secondaryFirst: true });
    expect(splitDropArrangement("right", false))
      .toEqual({ orientation: "columns", secondaryFirst: false });
    expect(splitDropArrangement("top", false))
      .toEqual({ orientation: "rows", secondaryFirst: true });
    expect(splitDropArrangement("bottom", false))
      .toEqual({ orientation: "rows", secondaryFirst: false });
    expect(splitDropArrangement("left", true))
      .toEqual({ orientation: "columns", secondaryFirst: false });
    expect(splitDropArrangement("bottom", true))
      .toEqual({ orientation: "rows", secondaryFirst: true });
  });

  it("persists the orientation and falls back to side by side", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };

    expect(readSplitOrientation(storage)).toBe("columns");
    persistSplitOrientation(storage, "rows");
    expect(stored.get(SPLIT_ORIENTATION_STORAGE_KEY)).toBe("rows");
    expect(readSplitOrientation(storage)).toBe("rows");
    stored.set(SPLIT_ORIENTATION_STORAGE_KEY, "diagonal");
    expect(readSplitOrientation(storage)).toBe("columns");
  });
});
