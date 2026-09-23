import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MODE_FRAMES,
  resolvePreset,
  STATE_TO_MODE,
  type OrbSize,
  type OrbState,
} from "../../src/renderer/src/vendor/thinking-orbs";

interface GoldenCase {
  key: string;
  state: OrbState;
  size: OrbSize;
  mode: string;
  t: number;
  dotCount: number;
  lineCount: number;
  dots: number[][];
  lines: number[][];
}

interface GoldenSubset {
  times: number[];
  resolved: Record<string, { mode: string; speed: number; opts: Record<string, number> }>;
  cases: GoldenCase[];
}

const golden = JSON.parse(readFileSync(
  new URL("../fixtures/thinking-orbs/golden-subset.json", import.meta.url),
  "utf8",
)) as GoldenSubset;

const TOLERANCE = 1e-6;

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function expectClose(actual: number, expected: number, label: string): void {
  if (Math.abs(rounded(actual) - expected) > TOLERANCE) {
    throw new Error(`${label}: ${rounded(actual)} differs from ${expected}`);
  }
}

describe("vendored thinking-orbs engine", () => {
  it("covers every design at both tuned sizes and two instants", () => {
    const states = Object.keys(STATE_TO_MODE) as OrbState[];
    expect(states).toHaveLength(9);
    expect(golden.cases).toHaveLength(states.length * 2 * golden.times.length);
    for (const state of states) {
      for (const size of [64, 20] as const) {
        for (const t of golden.times) {
          expect(golden.cases.some((entry) =>
            entry.state === state && entry.size === size && entry.t === t)).toBe(true);
        }
      }
    }
  });

  it("resolves every preset exactly as upstream does", () => {
    for (const [key, expected] of Object.entries(golden.resolved)) {
      const separator = key.lastIndexOf("-");
      const state = key.slice(0, separator) as OrbState;
      const size = Number(key.slice(separator + 1)) as OrbSize;
      const resolved = resolvePreset(state, size);
      expect(resolved.mode).toBe(expected.mode);
      expect(resolved.speed).toBe(expected.speed);
      expect(Object.keys(resolved.opts).sort()).toEqual(Object.keys(expected.opts).sort());
      for (const [option, value] of Object.entries(expected.opts)) {
        expectClose(resolved.opts[option] ?? Number.NaN, value, `${key}.${option}`);
      }
    }
  });

  it("matches the upstream golden vectors within 1e-6", () => {
    for (const entry of golden.cases) {
      const { mode, opts } = resolvePreset(entry.state, entry.size);
      expect(mode).toBe(entry.mode);
      const frame = MODE_FRAMES[mode](entry.size, entry.t, opts);
      expect(frame.dots, entry.key).toHaveLength(entry.dotCount);
      expect(frame.lines, entry.key).toHaveLength(entry.lineCount);
      for (const [index, x, y, z, r, white, alpha] of entry.dots) {
        const dot = frame.dots[index!]!;
        const label = `${entry.key} dot ${index}`;
        expectClose(dot.x, x!, `${label} x`);
        expectClose(dot.y, y!, `${label} y`);
        expectClose(dot.z, z!, `${label} z`);
        expectClose(dot.r, r!, `${label} r`);
        expectClose(dot.white, white!, `${label} white`);
        expectClose(dot.a ?? 1, alpha!, `${label} a`);
      }
      for (const [index, x1, y1, x2, y2, white, alpha, width] of entry.lines) {
        const line = frame.lines[index!]!;
        const label = `${entry.key} line ${index}`;
        expectClose(line.x1, x1!, `${label} x1`);
        expectClose(line.y1, y1!, `${label} y1`);
        expectClose(line.x2, x2!, `${label} x2`);
        expectClose(line.y2, y2!, `${label} y2`);
        expectClose(line.white, white!, `${label} white`);
        expectClose(line.a ?? 1, alpha!, `${label} a`);
        expectClose(line.w, width!, `${label} w`);
      }
    }
  });

  it("returns a fresh frame without mutating the cached preset", () => {
    const preset = resolvePreset("connecting", 20);
    const snapshot = JSON.stringify(preset);
    const first = MODE_FRAMES[preset.mode](20, 1.25, preset.opts);
    const second = MODE_FRAMES[preset.mode](20, 1.25, preset.opts);
    expect(second).toEqual(first);
    expect(second.dots).not.toBe(first.dots);
    expect(JSON.stringify(preset)).toBe(snapshot);
  });
});
