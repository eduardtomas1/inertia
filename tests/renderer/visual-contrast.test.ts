import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

type Rgb = readonly [number, number, number];

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "u"))
    ?.groups?.body ?? "";
}

function hexTokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--(?<name>[\w-]+):\s*(?<value>#[\da-f]{6})\s*;/giu)]
      .map((match) => [match.groups!.name!, match.groups!.value!] as const),
  );
}

function rgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function themeTokens(theme: "light" | "dark"): Map<string, string> {
  const tokens = hexTokens(cssBlock(":root"));
  if (theme === "dark") {
    for (const [name, value] of hexTokens(cssBlock(':root[data-theme="dark"]'))) {
      tokens.set(name, value);
    }
  }
  return tokens;
}

describe("visual contrast system", () => {
  it.each(["light", "dark"] as const)(
    "keeps %s primary, secondary, metadata, and semantic text readable",
    (theme) => {
      const tokens = themeTokens(theme);
      const surfaces = [
        "app-bg",
        "surface",
        "surface-strong",
        "surface-muted",
      ] as const;
      const readableText = [
        "text",
        "text-soft",
        "text-muted",
        "accent",
        "accent-strong",
        "danger",
        "warning",
        "status-working",
        "status-input",
        "status-failed",
        "status-completed",
      ] as const;

      for (const foregroundName of readableText) {
        for (const backgroundName of surfaces) {
          const foreground = tokens.get(foregroundName);
          const background = tokens.get(backgroundName);
          expect(foreground, `missing --${foregroundName}`).toBeDefined();
          expect(background, `missing --${backgroundName}`).toBeDefined();
          expect(
            contrast(foreground!, background!),
            `${theme} --${foregroundName} on --${backgroundName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      expect(
        contrast(tokens.get("accent-text")!, tokens.get("accent")!),
        `${theme} accent text on accent action`,
      ).toBeGreaterThanOrEqual(4.5);

      for (const backgroundName of surfaces) {
        expect(
          contrast(tokens.get("accent")!, tokens.get(backgroundName)!),
          `${theme} focus ring on --${backgroundName}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps the %s syntax palette readable on its dedicated code surface",
    (theme) => {
      const tokens = themeTokens(theme);
      const codeSurface = tokens.get("code-surface");
      expect(codeSurface, "missing --code-surface").toBeDefined();

      for (const foregroundName of [
        "syntax-keyword",
        "syntax-string",
        "syntax-number",
        "syntax-function",
        "syntax-variable",
        "syntax-comment",
        "syntax-meta",
        "syntax-deletion",
      ]) {
        const foreground = tokens.get(foregroundName);
        expect(foreground, `missing --${foregroundName}`).toBeDefined();
        expect(
          contrast(foreground!, codeSurface!),
          `${theme} --${foregroundName} on --code-surface`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps the %s working-text wave readable and visibly distinct",
    (theme) => {
      const tokens = themeTokens(theme);
      const rest = tokens.get("active-work-text-rest");
      const highlight = tokens.get("active-work-text-highlight");
      const surface = tokens.get("surface-strong");

      expect(rest, "missing --active-work-text-rest").toBeDefined();
      expect(highlight, "missing --active-work-text-highlight").toBeDefined();
      expect(surface, "missing --surface-strong").toBeDefined();
      expect(contrast(rest!, surface!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(highlight!, surface!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rest!, highlight!)).toBeGreaterThanOrEqual(1.8);
    },
  );

  it("keeps the dark canvas and everyday surfaces neutral graphite", () => {
    const tokens = themeTokens("dark");
    for (const tokenName of [
      "app-bg",
      "sidebar-bg",
      "surface",
      "surface-strong",
      "surface-muted",
      "surface-hover",
    ]) {
      const value = tokens.get(tokenName);
      expect(value, `missing --${tokenName}`).toBeDefined();
      const channels = rgb(value!);
      expect(
        Math.max(...channels) - Math.min(...channels),
        `dark --${tokenName} should not carry a blue cast`,
      ).toBeLessThanOrEqual(4);
    }
    expect(luminance(tokens.get("app-bg")!)).toBeLessThan(
      luminance(tokens.get("surface")!),
    );
    expect(luminance(tokens.get("surface")!)).toBeLessThan(
      luminance(tokens.get("surface-hover")!),
    );
  });

  it("defines the shared interaction, selection, state-surface, and compatibility aliases", () => {
    const root = cssBlock(":root");
    for (const token of [
      "--focus-ring",
      "--focus-ring-soft",
      "--interactive-border",
      "--interactive-border-hover",
      "--selected-surface",
      "--selected-surface-strong",
      "--approval-surface",
      "--question-surface",
      "--warning-surface",
      "--failure-surface",
      "--success-surface",
      "--disabled-opacity",
      "--text-faint",
      "--success",
      "--mono",
    ]) {
      expect(root, `missing ${token}`).toContain(`${token}:`);
    }

    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su,
    );
    expect(css).toMatch(
      /\.message-scroll:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--focus-ring\)/su,
    );
    expect(css).toMatch(
      /\.workspace-repository-group > details > summary:focus-visible,\s*\.workspace-repository-file:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su,
    );
  });

  it("distinguishes selected navigation, files, models, and workspace tabs from hover", () => {
    expect(css).toMatch(
      /\.change-file-button\.is-selected,\s*\.file-entry\.is-selected\s*\{[^}]*background:\s*var\(--selected-surface\);[^}]*box-shadow:/su,
    );
    expect(css).toMatch(
      /\.workspace-panel-tab\.is-active\s*\{[^}]*background:\s*var\(--selected-surface\);/su,
    );
    expect(css).toMatch(
      /\.settings-navigation nav button\.is-active\s*\{[^}]*background:\s*var\(--selected-surface\);/su,
    );
    expect(css).toMatch(
      /\.model-chooser-row\.is-active\s*\{[^}]*background:\s*var\(--selected-surface\);/su,
    );
    expect(css).toMatch(
      /\.model-source-rail-item\.is-selected\s*\{[^}]*background:\s*var\(--selected-surface\);/su,
    );
  });
});
