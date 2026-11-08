import type { DiffLine } from "@shared/contracts";

/**
 * One visual row of the side-by-side view. Indexes point into `hunk.lines`,
 * so selection, review and reversal keep using the unified line identities.
 * A `null` side is a placeholder that keeps the old and new columns aligned.
 */
export type DiffSplitRow =
  | { kind: "context"; index: number }
  | { kind: "meta"; index: number }
  | { kind: "change"; left: number | null; right: number | null };

export function diffSplitRows(lines: readonly Pick<DiffLine, "kind">[]): DiffSplitRow[] {
  const rows: DiffSplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const kind = lines[index]!.kind;
    if (kind === "context" || kind === "meta") {
      rows.push({ kind, index });
      index += 1;
      continue;
    }
    const deletions: number[] = [];
    const additions: number[] = [];
    const metas: number[] = [];
    while (index < lines.length && (lines[index]!.kind === "deletion" || lines[index]!.kind === "meta")) {
      if (lines[index]!.kind === "deletion") deletions.push(index);
      else metas.push(index);
      index += 1;
    }
    while (index < lines.length && (lines[index]!.kind === "addition" || lines[index]!.kind === "meta")) {
      if (lines[index]!.kind === "addition") additions.push(index);
      else metas.push(index);
      index += 1;
    }
    for (let row = 0; row < Math.max(deletions.length, additions.length); row += 1) {
      rows.push({ kind: "change", left: deletions[row] ?? null, right: additions[row] ?? null });
    }
    for (const meta of metas) rows.push({ kind: "meta", index: meta });
  }
  return rows;
}

/** Indexes of the hunk lines shown in a row. */
export function diffSplitRowLines(row: DiffSplitRow): number[] {
  if (row.kind !== "change") return [row.index];
  return [row.left, row.right].filter((index): index is number => index !== null);
}
