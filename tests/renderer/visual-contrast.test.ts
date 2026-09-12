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
  "../../src/renderer/src/components/conversation-context/ConversationContextDialog.css",
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

const themeCases = COLOR_THEME_IDS.flatMap((colorTheme) =>
  (["light", "dark"] as const).map((theme) => [colorTheme, theme] as const));

describe("visual contrast system", () => {
  it.each(themeCases)("keeps the %s %s palette readable", (colorTheme, theme) => {
    const tokens = themeTokens(theme, colorTheme);
    const surfaces = [
      "app-bg",
      "surface",
      "surface-strong",
      "surface-muted",
      "surface-hover",
    ];
    for (const foregroundName of ["text", "text-soft", "text-muted", "status-idle"]) {
      for (const backgroundName of surfaces) {
        expect(contrast(
          tokens.get(foregroundName)!,
          tokens.get(backgroundName)!,
        ), `${colorTheme} ${theme} --${foregroundName} on --${backgroundName}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const backgroundName of surfaces) {
      expect(contrast(
        tokens.get("accent")!,
        tokens.get(backgroundName)!,
      ), `${colorTheme} ${theme} --accent on --${backgroundName}`)
        .toBeGreaterThanOrEqual(3);
      expect(contrast(
        tokens.get("danger")!,
        tokens.get(backgroundName)!,
      ), `${colorTheme} ${theme} --danger on --${backgroundName}`)
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
      for (const backgroundName of ["surface", "surface-strong", "surface-muted"]) {
        expect(contrast(
          tokens.get(foregroundName)!,
          tokens.get(backgroundName)!,
        ), `${colorTheme} ${theme} --${foregroundName} on --${backgroundName}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(tokens.get("accent-text")!, tokens.get("accent")!))
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.get("danger")!, tokens.get("danger-soft")!))
      .toBeGreaterThanOrEqual(4.5);

    const codeSurface = tokens.get("code-surface")!;
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
      expect(contrast(tokens.get(foregroundName)!, codeSurface),
        `${colorTheme} ${theme} --${foregroundName} on --code-surface`)
        .toBeGreaterThanOrEqual(4.5);
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

  it("uses the readable application typography scale for Git file metadata", () => {
    for (const selector of [
      ".change-file-status",
      ".change-file-path, .file-entry-path",
      ".change-file-stats",
    ]) {
      expect(cssBlock(selector)).toContain("font-size: var(--ui-font-micro)");
    }
  });

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
        "status-approval",
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

  it("uses defined semantic tokens and visible focus states for repaired controls", () => {
    expect(css).not.toMatch(
      /var\(--(?:accent-contrast|attention-state|input-bg|success-text)(?:[,)]|\s)/u,
    );
    expect(cssBlock(".c-xk")).toContain("color: var(--accent-text)");
    expect(cssBlock(".c-s input")).toContain("border: 1px solid var(--interactive-border)");
    expect(cssBlock(".c-s input")).toContain("background: var(--surface-strong)");
    expect(cssBlock(".c-p textarea")).toContain("background: var(--surface-strong)");
    expect(css).toMatch(
      /\.c-w > aside:first-child > button:hover small,[\s\S]*?color:\s*var\(--text-muted\)/u,
    );
    expect(cssBlock(".private-connect-indicator.is-active"))
      .toContain("color: var(--success-accent)");
    expect(cssBlock(".private-connect-indicator.has-pending"))
      .toContain("color: var(--warning-accent)");
    expect(css).toMatch(
      /\.new-branch-form input:focus-visible,[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/u,
    );
    expect(cssBlock(".preview-address-form:focus-within"))
      .toContain("box-shadow: 0 0 0 2px var(--focus-ring-soft)");
    expect(css).not.toMatch(
      /:disabled[^{]*\{[^}]*opacity:\s*0\./su,
    );
  });

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
      /\.workspace-repository-file:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su,
    );
  });

  it("keeps the repository scope and file navigator on shared readability tokens", () => {
    expect(cssBlock(".workspace-repository-scope-leading strong,\n.workspace-repository-scope-leading select"))
      .toContain("font-size: var(--ui-font-secondary)");
    expect(cssBlock(".workspace-repository-scope-meta"))
      .toContain("font-size: var(--ui-font-micro)");
    expect(cssBlock(".workspace-repository-file-copy strong"))
      .toContain("font-size: var(--ui-font-secondary)");
    expect(css).toMatch(
      /\.workspace-repository-file-copy small\s*\{[^}]*font-size:\s*var\(--ui-font-micro\)/su,
    );
    expect(cssBlock(".workspace-repository-file-stats"))
      .toContain("font: var(--ui-font-micro)/1.2");
    expect(css).toMatch(
      /@container \(max-width: 460px\)\s*\{[\s\S]*?\.workspace-repository-scope\s*\{[^}]*flex-direction:\s*column;/u,
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
    expect(css).toMatch(
      /\.project-row\.is-active \.project-name,\s*\.project-row\.is-active \.project-icon\s*\{[^}]*color:\s*var\(--accent-strong\);/su,
    );
    expect(css).toMatch(
      /\.project-row\.is-active \.project-name\s*\{[^}]*font-weight:\s*680;/su,
    );
    expect(css).toMatch(
      /\.conversation-row\.is-active\s*\{[^}]*background:\s*transparent;/su,
    );
    expect(css).toMatch(
      /\.conversation-row\.is-active::before\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--accent\);/su,
    );
  });

  it("animates only active ultra composer frames and honors reduced motion", () => {
    const ultraFrame = cssBlock(
      '.chat-workspace[data-reasoning-effort="ultra"] .composer-input-zone::after',
    );
    expect(ultraFrame).toContain("pointer-events: none");
    expect(ultraFrame).toContain("animation: ultra-reasoning-frame-flow 6s linear infinite");
    expect(ultraFrame).toContain("mask-composite: exclude");
    expect(ultraFrame).toContain("border-radius: inherit");
    expect(css).not.toMatch(
      /\.chat-workspace\[data-reasoning-effort="ultra"\](?: \.composer)?::after/u,
    );
    expect(css).toMatch(
      /\.app-shell\[data-document-visible="false"\][\s\S]*?\.chat-workspace\[data-reasoning-effort="ultra"\] \.composer-input-zone::after\s*\{[^}]*animation-play-state:\s*paused;/u,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-workspace\[data-reasoning-effort="ultra"\] \.composer-input-zone::after\s*\{[^}]*animation:\s*none;/u,
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
  // Mirrors ComposerToolbar: the attach button and the primary send/stop
  // action share `.icon-button` inside `.composer-input-actions`.
  document.body.innerHTML = [
    '<div class="composer-shell"><div class="composer"><div class="composer-toolbar">',
    '<div class="composer-input-actions" role="group">',
    '<button type="button" class="icon-button" data-role="attach"></button>',
    '<button type="button" class="icon-button send-button" data-role="primary"></button>',
    "</div></div></div></div>",
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
      const composerSurface = tokens.get("composer-surface");
      expect(composerSurface, "missing --composer-surface").toBeDefined();
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
