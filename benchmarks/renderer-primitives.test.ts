import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../src/shared/contracts";
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

describe("renderer primitive benchmark", () => {
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
