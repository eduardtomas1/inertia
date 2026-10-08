import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HTML_RENDER_THEME_VARIABLES } from "../../src/shared/html-render";

const styles = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "");

function declarations(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^{}]*)\\}`, "u").exec(styles)?.groups?.body ?? "";
  return new Map([...body.matchAll(/--(?<name>[\w-]+):\s*(?<value>[^;]+);/gu)]
    .map((match) => [match.groups!.name!, match.groups!.value!.trim()] as const));
}

function opaque(value: string, tokens: Map<string, string>, seen = new Set<string>()): boolean {
  if (/^#[\da-f]{6}$/iu.test(value)) return true;
  const alias = /^var\(--(?<name>[\w-]+)\)$/u.exec(value)?.groups?.name;
  if (alias) {
    if (seen.has(alias) || !tokens.has(alias)) return false;
    return opaque(tokens.get(alias)!, tokens, new Set([...seen, alias]));
  }
  const mix = /^color-mix\(in srgb,\s*(?<first>[^,]+?)(?:\s+[\d.]+%)?,\s*(?<second>[^,]+?)(?:\s+[\d.]+%)?\)$/u.exec(value)?.groups;
  if (mix) return opaque(mix.first!, tokens, seen) && opaque(mix.second!, tokens, seen);
  return false;
}

describe("visual reply theme tokens", () => {
  it.each(["light", "dark"] as const)("hands pages opaque %s colours", (theme) => {
    const tokens = declarations(":root");
    if (theme === "dark") for (const [name, value] of declarations(':root[data-theme="dark"]')) tokens.set(name, value);
    const colours = HTML_RENDER_THEME_VARIABLES
      .filter(([alias]) => !/^--(?:radius|font-)/u.test(alias));
    expect(colours.length).toBeGreaterThan(10);
    for (const [alias, token] of colours) {
      expect(opaque(`var(${token})`, tokens), `${theme} ${alias} from ${token}`).toBe(true);
    }
  });

  it("mixes the opaque fill and line at the same ink strength as the translucent ones", () => {
    const tokens = declarations(":root");
    const ink = (name: string) => /var\(--text\) (?<percent>[\d.]+)%/u.exec(tokens.get(name) ?? "")?.groups?.percent;
    expect(ink("fill-solid")).toBe(ink("fill"));
    expect(ink("line-solid")).toBe(ink("line"));
  });
});
