import type { IconNode } from "morphicons/react";

// Stable, module-scoped Lucide 1.31 geometry lets Morphicons reuse its
// normalization and plan caches without shipping the separate data package.
export const checkMorphIcon = [
  ["path", { d: "M20 6 9 17l-5-5" }],
] as const satisfies IconNode;

export const copyMorphIcon = [
  ["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
] as const satisfies IconNode;

export const loaderCircleMorphIcon = [
  ["path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }],
] as const satisfies IconNode;

export const arrowUpMorphIcon = [
  ["path", { d: "m5 12 7-7 7 7" }],
  ["path", { d: "M12 19V5" }],
] as const satisfies IconNode;

export const squareMorphIcon = [
  ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
] as const satisfies IconNode;
