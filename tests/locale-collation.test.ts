import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");
const comparison = /\.localeCompare\(|\bIntl\.Collator\(/gu;
const releasedMigrationComparisons = new Map([["server/persistence/migrations/runner.ts", 1]]);

function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = "";
  let start = open + 1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) {
        const last = source.slice(start, index).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (character === "," && depth === 1) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  throw new Error("Unbalanced comparison call.");
}

function defaultLocaleComparisons(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(comparison)) {
    const args = callArguments(source, match.index + match[0].length - 1);
    const locale = args[match[0].startsWith(".") ? 1 : 0];
    if (locale === undefined || locale === "undefined") {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

describe("locale-independent comparisons", () => {
  it("recognizes comparisons that rely on the default locale", () => {
    expect(defaultLocaleComparisons([
      "a.localeCompare(b, \"en\");",
      "a.localeCompare(b);",
      "a.localeCompare(f(b, \")\"), undefined, { numeric: true });",
      "new Intl.Collator();",
      "new Intl.Collator(undefined, { numeric: true });",
      "new Intl.Collator(\"en\", { numeric: true });",
      "a.localeCompare(",
      "  b,",
      ");",
    ].join("\n"))).toEqual([2, 3, 4, 5, 7]);
  });

  it("pins every source comparison to an explicit locale except frozen released migrations", () => {
    const violations = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => /\.[cm]?tsx?$/u.test(path) && !path.endsWith(".d.ts"))
      .flatMap((path) => {
        const lines = defaultLocaleComparisons(readFileSync(join(sourceRoot, path), "utf8"));
        return lines.length === releasedMigrationComparisons.get(path) ? [] : lines.map((line) => `${path}:${line}`);
      });

    expect(violations).toEqual([]);
  });
});
