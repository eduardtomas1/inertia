import type { SubagentDisclosureRow } from "./subagentDisclosure";
import {
  isLiveSubagentTrace,
  subagentNeedsReview,
} from "./subagentDisclosure";

export interface CompactSubagentDisclosureRow extends SubagentDisclosureRow {
  omittedAncestors: number;
}

export function compactSubagentDisclosureRows(
  rows: readonly SubagentDisclosureRow[],
  maxRows: number,
): CompactSubagentDisclosureRow[] {
  if (rows.length <= maxRows) {
    return rows.map((row) => ({ ...row, omittedAncestors: 0 }));
  }
  const byId = new Map(rows.map((row) => [row.trace.id, row]));
  const included = new Set<string>();
  const parentRow = (
    row: SubagentDisclosureRow,
  ): SubagentDisclosureRow | undefined => row.trace.parentTraceId
    ? byId.get(row.trace.parentTraceId)
    : undefined;
  const newestFirst = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) =>
      right.row.trace.sequence - left.row.trace.sequence
      || right.index - left.index)
    .map(({ row }) => row);
  const important = newestFirst.filter(({ trace }) =>
    isLiveSubagentTrace(trace) || subagentNeedsReview(trace));
  const importantIds = new Set(important.map(({ trace }) => trace.id));
  const importantParents = new Set(important.flatMap(({ trace }) =>
    trace.parentTraceId && importantIds.has(trace.parentTraceId)
      ? [trace.parentTraceId]
      : []));
  const importantLeaves = important.filter(({ trace }) =>
    !importantParents.has(trace.id));
  const reserved = (importantLeaves.length > 0 ? importantLeaves : important)
    .slice(0, maxRows);

  // Keep urgent branch endpoints represented before spending remaining rows
  // on context. Deep work must not hide a competing live or failed branch.
  for (const { trace } of reserved) included.add(trace.id);
  const frontiers = reserved.map((row) => parentRow(row));
  const frontierSeen = reserved.map(() => new Set<string>());
  while (included.size < maxRows) {
    let advanced = false;
    for (let index = 0; index < frontiers.length; index += 1) {
      let frontier = frontiers[index];
      while (frontier && included.has(frontier.trace.id)) {
        if (frontierSeen[index]?.has(frontier.trace.id)) {
          frontier = undefined;
          break;
        }
        frontierSeen[index]?.add(frontier.trace.id);
        frontier = parentRow(frontier);
      }
      if (frontier && frontierSeen[index]?.has(frontier.trace.id)) {
        frontier = undefined;
      }
      if (frontier) frontierSeen[index]?.add(frontier.trace.id);
      frontiers[index] = frontier ? parentRow(frontier) : undefined;
      if (!frontier) continue;
      included.add(frontier.trace.id);
      advanced = true;
      if (included.size >= maxRows) break;
    }
    if (!advanced) break;
  }

  const includeWithAncestors = (candidate: SubagentDisclosureRow): void => {
    const chain: SubagentDisclosureRow[] = [];
    const seen = new Set<string>();
    let current: SubagentDisclosureRow | undefined = candidate;
    while (current && !seen.has(current.trace.id)) {
      seen.add(current.trace.id);
      chain.unshift(current);
      current = parentRow(current);
    }
    const missing = chain.filter(({ trace }) => !included.has(trace.id));
    if (included.size + missing.length > maxRows) return;
    for (const { trace } of missing) included.add(trace.id);
  };
  for (const row of newestFirst) includeWithAncestors(row);

  const omittedAncestorCount = (row: SubagentDisclosureRow): number => {
    let count = 0;
    let current = parentRow(row);
    const seen = new Set<string>();
    while (
      current
      && !included.has(current.trace.id)
      && !seen.has(current.trace.id)
    ) {
      seen.add(current.trace.id);
      count += 1;
      current = parentRow(current);
    }
    return count;
  };
  const visibleDepth = new Map<string, number>();
  return rows
    .filter(({ trace }) => included.has(trace.id))
    .map((row) => {
      const parentDepth = row.trace.parentTraceId
        ? visibleDepth.get(row.trace.parentTraceId)
        : undefined;
      const depth = parentDepth === undefined ? 0 : Math.min(parentDepth + 1, 8);
      visibleDepth.set(row.trace.id, depth);
      return {
        ...row,
        depth,
        omittedAncestors: omittedAncestorCount(row),
      };
    });
}
