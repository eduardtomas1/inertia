import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";

import {
  COLOR_THEME_IDS,
  type ColorThemeId,
} from "../../src/shared/contracts";

const css = [
  "../../src/renderer/src/styles.css",
  "../../src/renderer/public/color-themes.css",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n")
  .replace(/\r\n?/gu, "\n");

type Rgb = readonly [number, number, number];

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "u"))
    ?.groups?.body ?? "";
}

function tokenDeclarations(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--(?<name>[\w-]+):\s*(?<value>[^;]+);/gu)]
      .map((match) => [match.groups!.name!, match.groups!.value!.trim()] as const),
  );
}

function resolvedHexTokens(declarations: Map<string, string>): Map<string, string> {
  const resolved = new Map<string, string>();
  const resolve = (name: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(name)) return undefined;
    const value = declarations.get(name);
    if (!value) return undefined;
    if (/^#[\da-f]{6}$/iu.test(value)) return value;
    const alias = /^var\(--(?<name>[\w-]+)\)$/u.exec(value)?.groups?.name;
    return alias ? resolve(alias, new Set([...seen, name])) : undefined;
  };
  for (const name of declarations.keys()) {
    const value = resolve(name);
    if (value) resolved.set(name, value);
  }
  return resolved;
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

function blend(foreground: string, background: string, opacity: number): string {
  const foregroundChannels = rgb(foreground);
  const backgroundChannels = rgb(background);
  return `#${foregroundChannels.map((channel, index) => Math.round(
    channel * opacity + backgroundChannels[index]! * (1 - opacity),
  ).toString(16).padStart(2, "0")).join("")}`;
}

function themeTokens(
  theme: "light" | "dark",
  colorTheme: ColorThemeId = "inertia",
): Map<string, string> {
  const declarations = tokenDeclarations(cssBlock(":root"));
  if (theme === "dark") {
    for (const [name, value] of tokenDeclarations(cssBlock(':root[data-theme="dark"]'))) {
      declarations.set(name, value);
    }
  }
  if (colorTheme !== "inertia") {
    const selector = `:root[data-theme="${theme}"][data-color-theme="${colorTheme}"]`;
    for (const [name, value] of tokenDeclarations(cssBlock(selector))) {
      declarations.set(name, value);
    }
  }
  return resolvedHexTokens(declarations);
}

function inkWeight(name: "fill" | "fill-strong"): number {
  const pattern = new RegExp(`--${name}:\\s*color-mix\\(in srgb, var\\(--text\\) (?<weight>[\\d.]+)%, transparent\\)`, "u");
  return Number.parseFloat(pattern.exec(cssBlock(":root"))?.groups?.weight ?? "0") / 100;
}

function paintedBackgrounds(tokens: Map<string, string>): Map<string, string> {
  const painted = new Map<string, string>();
  for (const surface of ["bg", "surface", "surface-raised"]) {
    const base = tokens.get(surface)!;
    painted.set(surface, base);
    for (const fill of ["fill", "fill-strong"] as const) {
      painted.set(`${fill} on ${surface}`, blend(tokens.get("text")!, base, inkWeight(fill)));
    }
  }
  return painted;
}

const themeCases = COLOR_THEME_IDS.flatMap((colorTheme) =>
  (["light", "dark"] as const).map((theme) => [colorTheme, theme] as const));

describe("visual contrast system", () => {
  it.each(themeCases)("keeps the %s %s palette readable", (colorTheme, theme) => {
    const tokens = themeTokens(theme, colorTheme);
    const painted = paintedBackgrounds(tokens);
    expect(painted.size).toBe(9);
    for (const foregroundName of ["text", "text-muted", "status-idle"]) {
      for (const [backgroundName, background] of painted) {
        expect(contrast(
          tokens.get(foregroundName)!,
          background,
        ), `${colorTheme} ${theme} --${foregroundName} on ${backgroundName}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const [backgroundName, background] of painted) {
      expect(contrast(
        tokens.get("accent")!,
        background,
      ), `${colorTheme} ${theme} --accent on ${backgroundName}`)
        .toBeGreaterThanOrEqual(3);
      expect(contrast(
        tokens.get("danger")!,
        background,
      ), `${colorTheme} ${theme} --danger on ${backgroundName}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    for (const foregroundName of [
      "danger",
      "warning",
      "status-working",
      "status-approval",
      "status-input",
      "status-failed",
      "status-completed",
    ]) {
      for (const [backgroundName, background] of painted) {
        expect(contrast(
          tokens.get(foregroundName)!,
          background,
        ), `${colorTheme} ${theme} --${foregroundName} on ${backgroundName}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(tokens.get("accent-text")!, tokens.get("accent")!))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.get("danger")!, tokens.get("danger-soft")!))
      .toBeGreaterThanOrEqual(4.5);

    const codeSurfaces = ["fill on bg", "fill on surface", "fill on surface-raised"]
      .map((name) => [name, painted.get(name)!] as const);
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
      for (const [codeName, codeSurface] of codeSurfaces) {
        expect(contrast(tokens.get(foregroundName)!, codeSurface),
          `${colorTheme} ${theme} --${foregroundName} on ${codeName}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }

    const root = cssBlock(":root");
    const faintWeight = Number.parseInt(
      /--text-faint:\s*color-mix\(in srgb, var\(--text-muted\) (?<weight>\d+)%/u
        .exec(root)?.groups?.weight ?? "0",
      10,
    ) / 100;
    const faintText = blend(
      tokens.get("text-muted")!,
      tokens.get("surface")!,
      faintWeight,
    );
    expect(contrast(faintText, tokens.get("surface")!),
      `${colorTheme} ${theme} --text-faint on --surface`)
      .toBeGreaterThanOrEqual(4.5);

    const disabledOpacity = Number.parseFloat(
      /--disabled-opacity:\s*(?<opacity>\d+(?:\.\d+)?)/u
        .exec(root)?.groups?.opacity ?? "0",
    );
    const surface = tokens.get("surface")!;
    expect(contrast(blend(tokens.get("text")!, surface, disabledOpacity), surface),
      `${colorTheme} ${theme} disabled primary text`)
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(blend(tokens.get("text-muted")!, surface, disabledOpacity), surface),
      `${colorTheme} ${theme} disabled secondary text`)
      .toBeGreaterThanOrEqual(3);
    expect(contrast(
      blend(tokens.get("accent-text")!, surface, disabledOpacity),
      blend(tokens.get("accent")!, surface, disabledOpacity),
    ), `${colorTheme} ${theme} disabled accent action`)
      .toBeGreaterThanOrEqual(3);
  });

  it.each(["light", "dark"] as const)(
    "keeps %s primary, secondary, metadata, and semantic text readable",
    (theme) => {
      const tokens = themeTokens(theme);
      const painted = paintedBackgrounds(tokens);
      const readableText = [
        "text",
        "text-muted",
        "accent",
        "accent-strong",
        "danger",
        "warning",
        "status-working",
        "status-approval",
        "status-input",
        "status-failed",
        "status-completed",
      ] as const;

      for (const foregroundName of readableText) {
        for (const [backgroundName, background] of painted) {
          const foreground = tokens.get(foregroundName);
          expect(foreground, `missing --${foregroundName}`).toBeDefined();
          expect(
            contrast(foreground!, background),
            `${theme} --${foregroundName} on ${backgroundName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      expect(
        contrast(tokens.get("accent-text")!, tokens.get("accent")!),
        `${theme} accent text on accent action`,
      ).toBeGreaterThanOrEqual(4.5);

      for (const [backgroundName, background] of painted) {
        expect(
          contrast(tokens.get("accent")!, background),
          `${theme} focus ring on ${backgroundName}`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("moves the new branch input border to the accent on focus", () => {
    expect(css).toMatch(
      /^:is\([^{]*\.new-branch-form input,[^{]*\):focus,[^{]*\{\s*outline: none;\s*border-color: var\(--accent\);/mu,
    );
    expect(css).toMatch(/\.new-branch-form input \{[^}]*border: 1px solid var\(--line\);/u);
  });

  it.each(["light", "dark"] as const)(
    "keeps the %s syntax palette readable on the code fill",
    (theme) => {
      const tokens = themeTokens(theme);
      const codeSurface = paintedBackgrounds(tokens).get("fill on bg");
      expect(codeSurface, "missing --fill on --bg").toBeDefined();

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
          `${theme} --${foregroundName} on --fill over --bg`,
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

  it("keeps visible focus outlines on the shared, transcript, and file navigator controls", () => {
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su,
    );
    for (const row of [".message-scroll", ".workspace-repository-file"]) {
      expect(css).toMatch(new RegExp(
        String.raw`^:is\([^{]*${row.replace(".", String.raw`\.`)},[^{]*\):focus-visible\s*\{\s*outline-offset:\s*-2px;`,
        "mu",
      ));
      expect(css).not.toMatch(new RegExp(
        String.raw`${row.replace(".", String.raw`\.`)}:focus-visible\s*\{[^}]*outline:\s*(?:0|none)`,
        "su",
      ));
    }
  });

  it("pauses maximum reasoning composer frames while hidden and stops them for reduced motion", () => {
    expect(css).toMatch(
      /\.app-shell\[data-document-visible="false"\][\s\S]*?\.composer\[data-maximum-reasoning="true"\]::after,[\s\S]*?\.composer-ultra-glow\s*\{[^}]*animation-play-state:\s*paused;/u,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.composer\[data-maximum-reasoning="true"\]::after\s*\{[^}]*animation:\s*none;/u,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.composer\[data-maximum-reasoning="true"\] > \.composer-ultra-glow\s*\{[^}]*display:\s*none;/u,
    );
  });
});

// Stylesheets that can style the composer primary action, in bundle order.
const composerCascadeCss = [
  "../../src/renderer/src/styles.css",
  "../../src/renderer/src/components/composer/ComposerSurface.css",
  "../../src/renderer/src/components/composer/ComposerSendActions.css",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n")
  .replace(/\r\n?/gu, "\n");

type StyleRule = { selectors: string[]; body: string; order: number };

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// Top-level style rules only; at-rule blocks (media, container, keyframes) are skipped.
function topLevelStyleRules(source: string): StyleRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: StyleRule[] = [];
  let depth = 0;
  let start = 0;
  let prelude = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      if (depth === 0) {
        prelude = text.slice(start, index).trim();
        start = index + 1;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!prelude.startsWith("@")) {
          rules.push({
            selectors: splitTopLevel(prelude),
            body: text.slice(start, index),
            order: rules.length,
          });
        }
        start = index + 1;
      }
    } else if (character === ";" && depth === 0) {
      start = index + 1;
    }
  }
  return rules;
}

function withoutWhere(selector: string): string {
  let output = "";
  let index = 0;
  while (index < selector.length) {
    if (!selector.startsWith(":where(", index)) {
      output += selector[index];
      index += 1;
      continue;
    }
    let depth = 0;
    for (index += ":where".length; index < selector.length; index += 1) {
      if (selector[index] === "(") depth += 1;
      else if (selector[index] === ")" && (depth -= 1) === 0) {
        index += 1;
        break;
      }
    }
  }
  return output;
}

function specificity(selector: string): number {
  const counted = withoutWhere(selector)
    .replace(/:(?:not|is|has)\(/gu, " ")
    .replace(/\)/gu, " ");
  const ids = counted.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = counted.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/gu)?.length ?? 0;
  const types = counted
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/gu, " ")
    .match(/[a-z][\w-]*/giu)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

function declaredValue(body: string, names: readonly string[]): string | undefined {
  let value: string | undefined;
  for (const declaration of body.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    if (names.includes(declaration.slice(0, separator).trim())) {
      value = declaration.slice(separator + 1).trim();
    }
  }
  return value;
}

const composerRules = topLevelStyleRules(composerCascadeCss);

// Resolves which declaration wins for an element: importance, then
// specificity, then source order. Hover is simulated by dropping `:hover`.
function cascadedValue(
  element: { matches(selector: string): boolean },
  names: readonly string[],
  hover: boolean,
): string | undefined {
  let winner: { value: string; rank: readonly [number, number, number] } | undefined;
  for (const rule of composerRules) {
    const declared = declaredValue(rule.body, names);
    if (!declared) continue;
    const important = declared.endsWith("!important");
    const value = declared.replace(/\s*!important$/u, "");
    for (const selector of rule.selectors) {
      if (selector.includes("::")) continue;
      if (/:(?:active|focus|focus-visible|focus-within)\b/u.test(selector)) continue;
      if (!hover && selector.includes(":hover")) continue;
      let matches = false;
      try {
        matches = element.matches(selector.replaceAll(":hover", ""));
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const rank = [important ? 1 : 0, specificity(selector), rule.order] as const;
      const wins = !winner
        || rank[0] > winner.rank[0]
        || (rank[0] === winner.rank[0] && rank[1] > winner.rank[1])
        || (rank[0] === winner.rank[0] && rank[1] === winner.rank[1] && rank[2] >= winner.rank[2]);
      if (wins) winner = { value, rank };
    }
  }
  return winner?.value;
}

function resolveColor(value: string, tokens: Map<string, string>): string | undefined {
  if (/^#[\da-f]{6}$/iu.test(value)) return value;
  const token = /^var\(--(?<name>[\w-]+)\)$/u.exec(value)?.groups?.name;
  if (token) return tokens.get(token);
  const mix = /^color-mix\(in srgb,\s*(?<first>var\(--[\w-]+\))\s+(?<weight>\d+(?:\.\d+)?)%,\s*(?<second>var\(--[\w-]+\))\)$/u
    .exec(value)?.groups;
  if (!mix) return undefined;
  const first = resolveColor(mix.first!, tokens);
  const second = resolveColor(mix.second!, tokens);
  return first && second
    ? blend(first, second, Number.parseFloat(mix.weight!) / 100)
    : undefined;
}

// Icons are non-text UI graphics, so WCAG 1.4.11 asks for 3:1. The inactive
// (empty draft) Send state is exempt, but its glyph must stay perceptible.
const primaryActionStates = [
  { name: "send ready", classes: [], disabled: false, hover: false, minimumContrast: 3 },
  { name: "send hover", classes: [], disabled: false, hover: true, minimumContrast: 3 },
  { name: "send disabled", classes: [], disabled: true, hover: false, minimumContrast: 2 },
  { name: "sending", classes: ["send-button-loading"], disabled: true, hover: false, minimumContrast: 3 },
  { name: "stop ready", classes: ["stop-button"], disabled: false, hover: false, minimumContrast: 3 },
  { name: "stop hover", classes: ["stop-button"], disabled: false, hover: true, minimumContrast: 3 },
  { name: "stopping", classes: ["stop-button"], disabled: true, hover: false, minimumContrast: 3 },
] as const;

describe("composer primary action contrast", () => {
  const cascadeWindow = new Window();
  afterAll(async () => {
    await cascadeWindow.happyDOM.close();
  });
  const { document } = cascadeWindow;
  document.body.innerHTML = [
    '<div class="composer-shell"><div class="composer"><div class="composer-toolbar">',
    '<div class="composer-input-actions" role="group">',
    '<button type="button" class="icon-button send-button" data-role="primary"></button>',
    "</div>",
    '<div class="composer-primary-rail"><div class="composer-attach-actions" role="group">',
    '<button type="button" class="icon-button" data-role="attach"></button>',
    "</div></div></div></div></div>",
  ].join("");
  const attach = document.querySelector('[data-role="attach"]')!;
  const primary = document.querySelector('[data-role="primary"]')!;

  const cascades = primaryActionStates.map((state) => {
    primary.className = ["icon-button", "send-button", ...state.classes].join(" ");
    primary.toggleAttribute("disabled", state.disabled);
    return {
      state,
      color: cascadedValue(primary, ["color"], state.hover),
      background: cascadedValue(primary, ["background", "background-color"], state.hover),
      opacity: cascadedValue(primary, ["opacity"], state.hover),
    };
  });
  const rootDeclarations = tokenDeclarations(cssBlock(":root"));

  it("keeps the muted composer icon color off the primary send and stop action", () => {
    expect(cascadedValue(attach, ["color"], false)).toBe("var(--text-muted)");
    for (const { state, color } of cascades.filter(({ state }) => !state.disabled)) {
      expect(color, `${state.name} icon color`).not.toBe("var(--text-muted)");
    }
    expect(cascades.find(({ state }) => state.name === "send ready")?.color)
      .toBe("var(--accent-text)");
    expect(cascades.find(({ state }) => state.name === "stop ready")?.color)
      .toBe("var(--danger)");
  });

  it.each(themeCases)(
    "keeps the %s %s send and stop icons visible in every state",
    (colorTheme, theme) => {
      const tokens = themeTokens(theme, colorTheme);
      const composerSurface = tokens.get("surface-raised");
      expect(composerSurface, "missing --surface-raised").toBeDefined();
      for (const fill of ["fill", "fill-strong"] as const) {
        tokens.set(fill, blend(tokens.get("text")!, composerSurface!, inkWeight(fill)));
      }
      for (const { state, color, background, opacity } of cascades) {
        const label = `${colorTheme} ${theme} ${state.name}: ${color} on ${background}`;
        const foreground = color ? resolveColor(color, tokens) : undefined;
        const fill = background ? resolveColor(background, tokens) : undefined;
        expect(foreground, `${label} (icon color)`).toBeDefined();
        expect(fill, `${label} (button fill)`).toBeDefined();
        const opacityToken = opacity
          ? /^var\(--(?<name>[\w-]+)\)$/u.exec(opacity)?.groups?.name
          : undefined;
        const alpha = Number.parseFloat(
          (opacityToken ? rootDeclarations.get(opacityToken) : opacity) ?? "1",
        );
        expect(contrast(
          blend(foreground!, composerSurface!, alpha),
          blend(fill!, composerSurface!, alpha),
        ), label).toBeGreaterThanOrEqual(state.minimumContrast);
      }
    },
  );
});
