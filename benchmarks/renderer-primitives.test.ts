import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../src/shared/contracts";
import {
  createReasoningLinesReader,
  reasoningLines,
  type ReasoningLine,
} from "../src/renderer/src/utils/reasoningSummary";
import {
  isSafeWorkspaceEntryPath,
  sortWorkspaceEntries,
  workspacePathName,
} from "../src/renderer/src/utils/workspaceTree";

interface Measurement {
  case: string;
  mode: string;
  minimumMs: number;
  medianMs: number;
  maximumMs: number;
}

function measure(operation: () => void): Omit<Measurement, "case" | "mode"> {
  operation();
  const samples = Array.from({ length: 7 }, () => {
    const startedAt = performance.now();
    operation();
    return performance.now() - startedAt;
  }).sort((left, right) => left - right);
  return {
    minimumMs: samples[0]!,
    medianMs: samples[Math.floor(samples.length / 2)]!,
    maximumMs: samples.at(-1)!,
  };
}

function legacyCompareText(left: string, right: string): number {
  const primary = left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (primary !== 0) return primary;
  return left < right ? -1 : left > right ? 1 : 0;
}

function legacySortWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
): WorkspaceEntry[] {
  return entries
    .filter((entry) => isSafeWorkspaceEntryPath(entry.path))
    .slice()
    .sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      return legacyCompareText(
        workspacePathName(left.path),
        workspacePathName(right.path),
      ) || legacyCompareText(left.path, right.path);
    });
}

function workspaceFixture(): WorkspaceEntry[] {
  return Array.from({ length: 540 }, (_, index) => ({
    path: `${index % 13 === 0 ? "directory" : "file"}-${
      (index * 271) % 997
    }-${index % 23}`,
    kind: index % 13 === 0 ? "directory" : "file",
  }));
}

function reasoningFixture(characters: number): string {
  const sentence = "I need to inspect the projection hook and check whether the memo hits. ";
  let content = "";
  for (let section = 0; content.length < characters; section += 1) {
    content += `**Step ${section}: checking the module**\n\n${sentence.repeat(6)}\n\n`;
  }
  return content.slice(0, characters);
}

const REASONING_CHUNK = 6;
const REASONING_CHUNKS = 400;

function reasoningChunkMs(
  characters: number,
  createParse: () => (content: string) => ReasoningLine[],
): number {
  const full = reasoningFixture(characters);
  const base = full.slice(0, characters - REASONING_CHUNK * REASONING_CHUNKS);
  const chunks = Array.from({ length: REASONING_CHUNKS }, (_, index) => full.slice(
    base.length + index * REASONING_CHUNK,
    base.length + (index + 1) * REASONING_CHUNK,
  ));
  const samples = Array.from({ length: 9 }, () => {
    const parse = createParse();
    let content = base;
    parse(content);
    const startedAt = performance.now();
    for (const chunk of chunks) {
      content = `${content}${chunk}`;
      parse(content);
    }
    return (performance.now() - startedAt) / REASONING_CHUNKS;
  }).sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

describe("renderer primitive benchmark", () => {
  it("keeps the live thinking line's per-chunk parse flat as reasoning grows", () => {
    const rows = [
      ["full reparse", () => reasoningLines],
      ["incremental reader", createReasoningLinesReader],
      ["append and find the last line", () => (content: string) => {
        content.lastIndexOf("\n");
        return [];
      }],
    ] as const;
    const measurements = rows.map(([mode, createParse]) => {
      const smallMs = reasoningChunkMs(5_000, createParse);
      const largeMs = reasoningChunkMs(60_000, createParse);
      return { mode, smallMs, largeMs, ratio: largeMs / smallMs };
    });

    console.table(measurements.map((measurement) => ({
      case: `${REASONING_CHUNK}-character reasoning chunk`,
      mode: measurement.mode,
      "5 KB median ms": measurement.smallMs.toFixed(4),
      "60 KB median ms": measurement.largeMs.toFixed(4),
      "60 KB / 5 KB": measurement.ratio.toFixed(2),
    })));
    expect(measurements[1]!.ratio).toBeLessThan(3);
    expect(measurements[0]!.ratio).toBeGreaterThan(5);
  });

  it("compares per-comparison locale setup with a reusable collator", () => {
    const entries = workspaceFixture();
    expect(sortWorkspaceEntries(entries))
      .toEqual(legacySortWorkspaceEntries(entries));

    const measurements: Measurement[] = [];
    for (const [mode, operation] of [
      ["per-comparison locale setup", () => {
        for (let index = 0; index < 25; index += 1) {
          legacySortWorkspaceEntries(entries);
        }
      }],
      ["reused collator", () => {
        for (let index = 0; index < 25; index += 1) {
          sortWorkspaceEntries(entries);
        }
      }],
    ] as const) {
      measurements.push({
        case: "25 × 540-entry workspace sort",
        mode,
        ...measure(operation),
      });
    }

    console.table(measurements.map((measurement) => ({
      case: measurement.case,
      mode: measurement.mode,
      "minimum ms": measurement.minimumMs.toFixed(2),
      "median ms": measurement.medianMs.toFixed(2),
      "maximum ms": measurement.maximumMs.toFixed(2),
    })));
  });
});
