import type { SplitDropZone, SplitOrientation } from "./splitConversation";
import type { WorkspacePreviewOwner } from "./workspacePreviewFocus";

export type SplitPaneOwner = WorkspacePreviewOwner;

export type SplitLayout =
  | { owner: SplitPaneOwner }
  | {
      axis: SplitOrientation;
      ratio: number;
      first: SplitLayout;
      second: SplitLayout;
    };

type SplitLeaf = Extract<SplitLayout, { owner: SplitPaneOwner }>;

export type SplitDropPlan =
  | { kind: "insert"; owner: SplitPaneOwner; target: SplitPaneOwner; zone: SplitDropZone }
  | { kind: "move"; owner: SplitPaneOwner; target: SplitPaneOwner; zone: SplitDropZone }
  | { kind: "swap"; owner: SplitPaneOwner; target: SplitPaneOwner }
  | { kind: "replace"; target: SplitPaneOwner };

export interface SplitPaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitHandle {
  path: string;
  axis: SplitOrientation;
  ratio: number;
  rect: SplitPaneRect;
  first: SplitPaneOwner[];
  second: SplitPaneOwner[];
}

export const SPLIT_LAYOUT_STORAGE_KEY =
  "inertia:layout:conversation-split-layout:v1";
export const PINNED_SPLIT_OWNERS = ["secondary", "tertiary", "quaternary"] as const;
export const PRIMARY_SPLIT_LAYOUT: SplitLayout = { owner: "primary" };

const OWNERS: ReadonlySet<string> = new Set(["primary", ...PINNED_SPLIT_OWNERS]);
const MIN_RATIO = 30;
const MAX_RATIO = 70;

export function clampSplitRatio(ratio: number): number {
  return Number.isFinite(ratio)
    ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
    : 50;
}

export function splitLeaves(layout: SplitLayout): SplitPaneOwner[] {
  return "owner" in layout
    ? [layout.owner]
    : [...splitLeaves(layout.first), ...splitLeaves(layout.second)];
}

function validNode(
  value: unknown,
  parentAxis: SplitOrientation | null,
  depth: number,
): value is SplitLayout {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if ("owner" in node) return typeof node.owner === "string" && OWNERS.has(node.owner);
  return depth < 2
    && (node.axis === "columns" || node.axis === "rows")
    && node.axis !== parentAxis
    && typeof node.ratio === "number"
    && validNode(node.first, node.axis, depth + 1)
    && validNode(node.second, node.axis, depth + 1);
}

export function isValidSplitLayout(value: unknown): value is SplitLayout {
  if (!validNode(value, null, 0)) return false;
  const leaves = splitLeaves(value);
  return leaves.length <= 4
    && new Set(leaves).size === leaves.length
    && leaves.includes("primary");
}

export function readSplitLayout(
  storage: Pick<Storage, "getItem">,
): SplitLayout | null {
  try {
    const value: unknown = JSON.parse(
      storage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? "null",
    );
    return isValidSplitLayout(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistSplitLayout(
  storage: Pick<Storage, "setItem">,
  layout: SplitLayout,
): void {
  storage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

function transform(
  layout: SplitLayout,
  leaf: (node: SplitLeaf) => SplitLayout | null,
): SplitLayout | null {
  if ("owner" in layout) return leaf(layout);
  const first = transform(layout.first, leaf);
  const second = transform(layout.second, leaf);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second
    ? layout
    : { ...layout, first, second };
}

export function removeSplitPane(
  layout: SplitLayout,
  owner: SplitPaneOwner,
): SplitLayout {
  return transform(layout, (node) => node.owner === owner ? null : node)
    ?? PRIMARY_SPLIT_LAYOUT;
}

export function insertSplitPane(
  layout: SplitLayout,
  target: SplitPaneOwner,
  zone: SplitDropZone,
  owner: SplitPaneOwner,
): SplitLayout | null {
  if (splitLeaves(layout).includes(owner)) return null;
  const axis = zone === "left" || zone === "right" ? "columns" : "rows";
  const ownerFirst = zone === "left" || zone === "top";
  const next = transform(layout, (node) => node.owner !== target ? node : {
    axis,
    ratio: 50,
    first: ownerFirst ? { owner } : node,
    second: ownerFirst ? node : { owner },
  });
  return next && isValidSplitLayout(next) ? next : null;
}

export function moveSplitPane(
  layout: SplitLayout,
  owner: SplitPaneOwner,
  target: SplitPaneOwner,
  zone: SplitDropZone,
): SplitLayout | null {
  if (owner === target) return null;
  return insertSplitPane(removeSplitPane(layout, owner), target, zone, owner);
}

export function swapSplitPanes(
  layout: SplitLayout,
  first: SplitPaneOwner,
  second: SplitPaneOwner,
): SplitLayout {
  return transform(layout, (node) => node.owner === first
    ? { owner: second }
    : node.owner === second ? { owner: first } : node) ?? layout;
}

export function toggleSplitAxis(layout: SplitLayout): SplitLayout {
  if ("owner" in layout) return layout;
  return {
    ...layout,
    axis: layout.axis === "columns" ? "rows" : "columns",
    first: toggleSplitAxis(layout.first),
    second: toggleSplitAxis(layout.second),
  };
}

export function setSplitRatio(
  layout: SplitLayout,
  path: string,
  ratio: number,
): SplitLayout {
  if ("owner" in layout) return layout;
  if (!path) return { ...layout, ratio: clampSplitRatio(ratio) };
  return path.startsWith("0")
    ? { ...layout, first: setSplitRatio(layout.first, path.slice(1), ratio) }
    : { ...layout, second: setSplitRatio(layout.second, path.slice(1), ratio) };
}

export function addSplitPane(
  layout: SplitLayout,
  owner: SplitPaneOwner,
  ratio = 50,
): SplitLayout {
  if ("owner" in layout) {
    return layout.owner === owner
      ? layout
      : { axis: "columns", ratio: clampSplitRatio(ratio), first: layout, second: { owner } };
  }
  for (const target of splitLeaves(layout).reverse()) {
    for (const zone of ["bottom", "right"] as const) {
      const next = insertSplitPane(layout, target, zone, owner);
      if (next) return next;
    }
  }
  return layout;
}

export function reconcileSplitLayout(
  layout: SplitLayout,
  owners: readonly SplitPaneOwner[],
  ratio = 50,
): SplitLayout {
  let next = transform(layout, (node) => owners.includes(node.owner) ? node : null)
    ?? PRIMARY_SPLIT_LAYOUT;
  for (const owner of owners) {
    if (!splitLeaves(next).includes(owner)) next = addSplitPane(next, owner, ratio);
  }
  return next;
}

export function withSecondaryFirst(
  layout: SplitLayout,
  secondaryFirst: boolean,
): SplitLayout {
  const leaves = splitLeaves(layout);
  if (
    leaves.length !== 2
    || !leaves.includes("secondary")
    || (leaves[0] === "secondary") === secondaryFirst
  ) {
    return layout;
  }
  return swapSplitPanes(layout, "primary", "secondary");
}

export function planSplitDrop(
  layout: SplitLayout,
  dragged: SplitPaneOwner | null,
  target: SplitPaneOwner,
  zones: readonly SplitDropZone[],
  freeOwner: SplitPaneOwner | null,
): SplitDropPlan | null {
  if (dragged === target || zones.length === 0) return null;
  if (dragged) {
    const zone = zones.find((candidate) => moveSplitPane(layout, dragged, target, candidate));
    return zone
      ? { kind: "move", owner: dragged, target, zone }
      : { kind: "swap", owner: dragged, target };
  }
  const zone = freeOwner
    ? zones.find((candidate) => insertSplitPane(layout, target, candidate, freeOwner))
    : undefined;
  return zone && freeOwner
    ? { kind: "insert", owner: freeOwner, target, zone }
    : { kind: "replace", target };
}

export function applySplitDrop(
  layout: SplitLayout,
  plan: SplitDropPlan,
): SplitLayout {
  switch (plan.kind) {
    case "insert":
      return insertSplitPane(layout, plan.target, plan.zone, plan.owner) ?? layout;
    case "move":
      return moveSplitPane(layout, plan.owner, plan.target, plan.zone) ?? layout;
    case "swap":
      return swapSplitPanes(layout, plan.owner, plan.target);
    case "replace":
      return layout;
  }
}

export function splitGeometry(
  layout: SplitLayout,
  stacked: boolean,
): { panes: Map<SplitPaneOwner, SplitPaneRect>; handles: SplitHandle[] } {
  const panes = new Map<SplitPaneOwner, SplitPaneRect>();
  const handles: SplitHandle[] = [];
  const visit = (node: SplitLayout, rect: SplitPaneRect, path: string): void => {
    if ("owner" in node) {
      panes.set(node.owner, rect);
      return;
    }
    const axis = stacked ? "rows" : node.axis;
    const share = node.ratio / 100;
    handles.push({
      path,
      axis,
      ratio: node.ratio,
      rect,
      first: splitLeaves(node.first),
      second: splitLeaves(node.second),
    });
    if (axis === "columns") {
      visit(node.first, { ...rect, width: rect.width * share }, `${path}0`);
      visit(node.second, {
        ...rect,
        x: rect.x + rect.width * share,
        width: rect.width * (1 - share),
      }, `${path}1`);
      return;
    }
    visit(node.first, { ...rect, height: rect.height * share }, `${path}0`);
    visit(node.second, {
      ...rect,
      y: rect.y + rect.height * share,
      height: rect.height * (1 - share),
    }, `${path}1`);
  };
  visit(layout, { x: 0, y: 0, width: 1, height: 1 }, "");
  return { panes, handles };
}
