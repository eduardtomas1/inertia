import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface Rule {
  file: string;
  selectors: string[];
  body: string;
  forcedColors: boolean;
}

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "mascot" ? [] : cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

function rules(file: string): Rule[] {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      stack.push(source.slice(start, index).trim());
      start = index + 1;
    } else if (character === "}") {
      const prelude = stack.pop();
      const body = source.slice(start, index);
      if (prelude !== undefined && !body.includes("{") && !prelude.startsWith("@")) {
        found.push({
          file,
          selectors: splitSelectors(prelude),
          body,
          forcedColors: stack.some((parent) => parent.includes("forced-colors")),
        });
      }
      start = index + 1;
    }
  }
  return found;
}

function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of prelude) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => part.replace(/\s+/gu, " "));
}

function innerList(selector: string): string[] {
  const opening = /^:(?:is|where)\(/u.exec(selector);
  if (!opening) return [selector];
  let depth = 0;
  for (let index = opening[0].length - 1; index < selector.length; index += 1) {
    if (selector[index] === "(") depth += 1;
    if (selector[index] === ")") depth -= 1;
    if (depth === 0) {
      const suffix = selector.slice(index + 1);
      return splitSelectors(selector.slice(opening[0].length, index)).map((item) => `${item}${suffix}`);
    }
  }
  return [selector];
}

const all = cssFiles("src/renderer/src").flatMap(rules);
const visibleFocus = /(?:^|;)\s*(?:outline(?:-color)?:\s*(?!none|0\b)|box-shadow:\s*(?!none)|border(?:-[a-z]+)?-color:|background(?:-color)?:|opacity:)/u;

const focusSelectors = all
  .filter((rule) => !rule.forcedColors && visibleFocus.test(rule.body.replace(/\n/gu, ";")))
  .flatMap((rule) => rule.selectors.flatMap(innerList))
  .flatMap((selector) => {
    const inner = /:has\((?<focused>[^()]*:focus(?:-visible|-within)?)\)/u.exec(selector)?.groups?.focused;
    return inner ? [selector, inner] : [selector];
  })
  .filter((selector) => /:focus(?:-visible|-within)?\b/u.test(selector) && !/^[^:]*:has\(/u.test(selector))
  .map((selector) => selector.replace(/:not\([^)]*\)/gu, ""));

const PROGRAMMATIC_CONTAINERS = new Map([
  [".cli-import-dialog", "dialog surface focused on open; its controls carry the ring"],
  [".welcome-guide", "dialog surface focused on open; its controls carry the ring"],
  [".html-render-dialog", "dialog surface focused on open; its controls carry the ring"],
  [".project-customize-loading", "transient loading placeholder focused while the panel loads"],
  [".multi-spawn-prompt-zone textarea", "field focus is the shared accent border"],
  [".working-orb-canvas", "decorative canvas without pointer events or a tab stop"],
]);

function candidates(selector: string): string[] {
  const subject = selector.replace(/:focus(?:-visible|-within)?/gu, "").replace(/:not\([^)]*\)/gu, "");
  const parts = subject.split(/\s*(?:>|\s)\s*/u).filter(Boolean);
  const list: string[] = [];
  for (let size = parts.length; size > 0; size -= 1) list.push(subject.split(/(?=\s|>)/u).slice(0, size).join("").trim());
  return [...new Set([subject, ...list])];
}

function covered(selector: string): boolean {
  if (/:focus-visible|:focus\b/u.test(selector)) return true;
  return candidates(selector).some((candidate) => focusSelectors.some((focus) => {
    const base = focus.replace(/:focus(?:-visible|-within)?.*$/u, "").trim();
    return base === candidate || base.endsWith(` ${candidate}`) || base.endsWith(`>${candidate}`);
  }));
}

describe("focus visibility guard", () => {
  it("never removes the outline from a focusable element without a visible focus replacement", () => {
    const offenders = all
      .filter((rule) => !rule.forcedColors && /outline:\s*(?:none|0)\s*(?:;|$)/u.test(rule.body))
      .flatMap((rule) => rule.selectors.flatMap(innerList).map((selector) => ({ file: rule.file, selector })))
      .filter(({ selector }) => !PROGRAMMATIC_CONTAINERS.has(selector) && !covered(selector))
      .map(({ file, selector }) => `${file}: ${selector}`);
    expect(offenders).toEqual([]);
  });
});
