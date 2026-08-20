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

export const sendMorphIcon = [
  ["path", {
    d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
  }],
  ["path", { d: "m21.854 2.147-10.94 10.939" }],
] as const satisfies IconNode;

export const sendHorizontalMorphIcon = [
  ["path", {
    d: "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z",
  }],
  ["path", { d: "M6 12h16" }],
] as const satisfies IconNode;

export const squareMorphIcon = [
  ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
] as const satisfies IconNode;
