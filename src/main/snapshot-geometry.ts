import type { SnapshotRect } from "../shared/snapshots.js";

export interface SnapshotImageScale { x: number; y: number }

export function snapshotImageScale(
  frame: SnapshotRect, image: { width: number; height: number }, tolerance = Infinity,
): SnapshotImageScale | null {
  const x = image.width / frame.width;
  const y = image.height / frame.height;
  if (![x, y].every((value) => Number.isFinite(value) && value > 0)) return null;
  return Math.abs(x - y) <= tolerance * Math.max(x, y) ? { x, y } : null;
}

export function snapshotMaskRect(rect: SnapshotRect, frame: SnapshotRect, scale: SnapshotImageScale): SnapshotRect {
  const left = Math.floor((rect.x - frame.x) * scale.x) - 2;
  const top = Math.floor((rect.y - frame.y) * scale.y) - 2;
  const right = Math.ceil((rect.x + rect.width - frame.x) * scale.x) + 2;
  const bottom = Math.ceil((rect.y + rect.height - frame.y) * scale.y) + 2;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
