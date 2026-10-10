import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "");

function rootBlocks(): string[] {
  return [...styles.matchAll(/(?:^|\n):root(?:\[[^\]]+\])*\s*\{(?<body>[^{}]*)\}/gu)].map((match) => match.groups!.body!);
}

function pixels(expression: string, em: number): number {
  const value = expression.trim();
  const max = /^max\((?<args>.*)\)$/u.exec(value)?.groups?.args;
  if (max) return Math.max(...max.split(",").map((part) => pixels(part, em)));
  const unit = /^(?<amount>\d*\.?\d+)(?<unit>px|em)$/u.exec(value)?.groups;
  if (!unit) throw new Error(`Unsupported size: ${value}`);
  return Number(unit.amount) * (unit.unit === "em" ? em : 1);
}

describe("type scale floor", () => {
  it("never renders code below 12px inside any text size at any interface scale", () => {
    const sizes = rootBlocks().flatMap((body) =>
      [...body.matchAll(/--text-(?:xs|sm|base|md|lg|xl|diff):\s*(?<value>[\d.]+)px;/gu)].map((match) => Number(match.groups!.value)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    const code = /\n\s*--text-code:\s*(?<value>[^;]+);/u.exec(styles)?.groups?.value;
    expect(code).toBeDefined();
    const smallest = Math.min(...sizes.map((size) => pixels(code!, size)));
    expect(smallest).toBeGreaterThanOrEqual(12);
  });
});
