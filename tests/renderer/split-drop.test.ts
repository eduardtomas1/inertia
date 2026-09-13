import { describe, expect, it } from "vitest";

import {
  splitDropRect,
  splitDropZone,
  splitDropZones,
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

  it("offers the nearest edge first and the nearest edge across it second", () => {
    expect(splitDropZones(workspace, 120, 250, false)).toEqual(["left", "bottom"]);
    expect(splitDropZones(workspace, 120, 200, false)).toEqual(["left", "top"]);
    expect(splitDropZones(workspace, 800, 60, false)).toEqual(["top", "right"]);
    expect(splitDropZones(workspace, 120, 100, true)).toEqual(["top"]);
    expect(splitDropZones(workspace, 99, 250, false)).toEqual([]);
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
});
