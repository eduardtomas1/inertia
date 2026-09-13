import { describe, expect, it } from "vitest";

import {
  addSplitPane,
  applySplitDrop,
  insertSplitPane,
  isValidSplitLayout,
  moveSplitPane,
  persistSplitLayout,
  planSplitDrop,
  PRIMARY_SPLIT_LAYOUT,
  readSplitLayout,
  reconcileSplitLayout,
  removeSplitPane,
  setSplitRatio,
  SPLIT_LAYOUT_STORAGE_KEY,
  splitGeometry,
  splitLeaves,
  swapSplitPanes,
  toggleSplitAxis,
  withSecondaryFirst,
  type SplitLayout,
} from "../../src/renderer/src/utils/splitLayout";

const pair: SplitLayout = {
  axis: "columns",
  ratio: 50,
  first: { owner: "primary" },
  second: { owner: "secondary" },
};

const grid: SplitLayout = {
  axis: "columns",
  ratio: 50,
  first: {
    axis: "rows",
    ratio: 50,
    first: { owner: "primary" },
    second: { owner: "quaternary" },
  },
  second: {
    axis: "rows",
    ratio: 50,
    first: { owner: "secondary" },
    second: { owner: "tertiary" },
  },
};

describe("split layout", () => {
  it("splits a single chat along any edge", () => {
    expect(insertSplitPane(PRIMARY_SPLIT_LAYOUT, "primary", "left", "secondary"))
      .toEqual({ ...pair, first: { owner: "secondary" }, second: { owner: "primary" } });
    expect(insertSplitPane(PRIMARY_SPLIT_LAYOUT, "primary", "bottom", "secondary"))
      .toEqual({ ...pair, axis: "rows" });
  });

  it("nests only across the parent axis, up to a two by two grid", () => {
    const three = insertSplitPane(pair, "secondary", "bottom", "tertiary");
    expect(three).toEqual({
      ...pair,
      second: {
        axis: "rows",
        ratio: 50,
        first: { owner: "secondary" },
        second: { owner: "tertiary" },
      },
    });
    expect(insertSplitPane(pair, "secondary", "right", "tertiary")).toBeNull();
    expect(insertSplitPane(three!, "tertiary", "bottom", "quaternary")).toBeNull();
    expect(insertSplitPane(three!, "tertiary", "right", "quaternary")).toBeNull();
    const four = insertSplitPane(three!, "primary", "bottom", "quaternary");
    expect(four).toEqual(grid);
    expect(splitLeaves(four!)).toEqual(["primary", "quaternary", "secondary", "tertiary"]);
  });

  it("refuses owners that are already shown", () => {
    expect(insertSplitPane(pair, "primary", "bottom", "secondary")).toBeNull();
  });

  it("collapses a split when one of its chats closes", () => {
    expect(removeSplitPane(grid, "quaternary")).toEqual({
      ...grid,
      first: { owner: "primary" },
    });
    expect(removeSplitPane(pair, "secondary")).toEqual(PRIMARY_SPLIT_LAYOUT);
  });

  it("moves a chat to another edge, or swaps when the edge is not allowed", () => {
    expect(moveSplitPane(pair, "secondary", "primary", "left"))
      .toEqual({ ...pair, first: { owner: "secondary" }, second: { owner: "primary" } });
    expect(moveSplitPane(pair, "secondary", "primary", "bottom"))
      .toEqual({ ...pair, axis: "rows" });
    expect(moveSplitPane(grid, "tertiary", "primary", "left")).toBeNull();
    expect(swapSplitPanes(grid, "tertiary", "primary")).toEqual({
      ...grid,
      first: { ...grid.first, first: { owner: "tertiary" } },
      second: { ...grid.second, second: { owner: "primary" } },
    });
  });

  it("plans drops as insert, move, swap or replace", () => {
    expect(planSplitDrop(PRIMARY_SPLIT_LAYOUT, null, "primary", ["right"], "secondary"))
      .toEqual({ kind: "insert", owner: "secondary", target: "primary", zone: "right" });
    expect(planSplitDrop(pair, null, "secondary", ["bottom"], "tertiary"))
      .toEqual({ kind: "insert", owner: "tertiary", target: "secondary", zone: "bottom" });
    expect(planSplitDrop(pair, null, "secondary", ["right"], "tertiary"))
      .toEqual({ kind: "replace", target: "secondary" });
    expect(planSplitDrop(grid, null, "tertiary", ["bottom"], null))
      .toEqual({ kind: "replace", target: "tertiary" });
    expect(planSplitDrop(pair, "secondary", "primary", ["top"], null))
      .toEqual({ kind: "move", owner: "secondary", target: "primary", zone: "top" });
    expect(planSplitDrop(grid, "tertiary", "primary", ["left"], null))
      .toEqual({ kind: "swap", owner: "tertiary", target: "primary" });
    expect(planSplitDrop(pair, "secondary", "secondary", ["left"], null)).toBeNull();
  });

  it("falls back to the other axis before replacing or swapping", () => {
    expect(planSplitDrop(pair, null, "secondary", ["right", "bottom"], "tertiary"))
      .toEqual({ kind: "insert", owner: "tertiary", target: "secondary", zone: "bottom" });
    expect(planSplitDrop(pair, null, "primary", ["left", "top"], "tertiary"))
      .toEqual({ kind: "insert", owner: "tertiary", target: "primary", zone: "top" });
    expect(planSplitDrop(grid, "tertiary", "primary", ["left", "bottom"], null))
      .toEqual({ kind: "swap", owner: "tertiary", target: "primary" });
    expect(planSplitDrop(pair, null, "primary", [], "tertiary")).toBeNull();
  });

  it("applies each plan to the layout", () => {
    expect(applySplitDrop(pair, { kind: "insert", owner: "tertiary", target: "secondary", zone: "top" }))
      .toEqual({
        ...pair,
        second: {
          axis: "rows",
          ratio: 50,
          first: { owner: "tertiary" },
          second: { owner: "secondary" },
        },
      });
    expect(applySplitDrop(pair, { kind: "swap", owner: "secondary", target: "primary" }))
      .toEqual({ ...pair, first: { owner: "secondary" }, second: { owner: "primary" } });
    expect(applySplitDrop(pair, { kind: "replace", target: "secondary" })).toBe(pair);
  });

  it("adds chats from the menu where there is room, ending in a grid", () => {
    const two = addSplitPane(PRIMARY_SPLIT_LAYOUT, "secondary", 62);
    expect(two).toEqual({ ...pair, ratio: 62 });
    const three = addSplitPane(two, "tertiary");
    expect(splitLeaves(three)).toEqual(["primary", "secondary", "tertiary"]);
    const four = addSplitPane(three, "quaternary");
    expect(splitLeaves(four)).toHaveLength(4);
    expect(isValidSplitLayout(four)).toBe(true);
  });

  it("reconciles the stored layout with the chats that can be shown", () => {
    expect(reconcileSplitLayout(grid, ["primary", "secondary"]))
      .toEqual({ ...pair, first: { owner: "primary" }, second: { owner: "secondary" } });
    expect(reconcileSplitLayout(PRIMARY_SPLIT_LAYOUT, ["primary", "secondary"], 64))
      .toEqual({ ...pair, ratio: 64 });
    expect(reconcileSplitLayout(pair, ["primary"])).toEqual(PRIMARY_SPLIT_LAYOUT);
  });

  it("keeps the two-chat promotion rule without touching larger layouts", () => {
    expect(splitLeaves(withSecondaryFirst(pair, true))).toEqual(["secondary", "primary"]);
    expect(withSecondaryFirst(pair, false)).toBe(pair);
    expect(withSecondaryFirst(grid, true)).toBe(grid);
  });

  it("flips every axis and clamps resized ratios", () => {
    expect(toggleSplitAxis(grid)).toEqual({
      ...grid,
      axis: "rows",
      first: { ...grid.first, axis: "columns" },
      second: { ...grid.second, axis: "columns" },
    });
    const resized = setSplitRatio(setSplitRatio(grid, "", 90), "1", 20);
    expect(resized).toMatchObject({ ratio: 70, second: { ratio: 30 } });
  });

  it("computes pane rectangles and handles, stacking everything when forced", () => {
    const { panes, handles } = splitGeometry(setSplitRatio(grid, "", 60), false);
    expect(panes.get("primary")).toEqual({ x: 0, y: 0, width: 0.6, height: 0.5 });
    expect(panes.get("tertiary")).toEqual({ x: 0.6, y: 0.5, width: 0.4, height: 0.5 });
    expect(handles.map(({ path, axis }) => [path, axis]))
      .toEqual([["", "columns"], ["0", "rows"], ["1", "rows"]]);
    expect(handles[0]).toMatchObject({
      first: ["primary", "quaternary"],
      second: ["secondary", "tertiary"],
    });
    const stacked = splitGeometry(pair, true);
    expect(stacked.panes.get("secondary")).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
  });

  it("persists only valid layouts", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };

    expect(readSplitLayout(storage)).toBeNull();
    persistSplitLayout(storage, grid);
    expect(readSplitLayout(storage)).toEqual(grid);
    for (const invalid of [
      "{",
      JSON.stringify({ owner: "secondary" }),
      JSON.stringify({ ...pair, second: { owner: "primary" } }),
      JSON.stringify({ ...pair, second: { ...pair, axis: "columns" } }),
      JSON.stringify({ ...pair, second: { owner: "fifth" } }),
    ]) {
      stored.set(SPLIT_LAYOUT_STORAGE_KEY, invalid);
      expect(readSplitLayout(storage)).toBeNull();
    }
  });
});
