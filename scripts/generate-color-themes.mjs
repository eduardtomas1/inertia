import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { oklchToHex } from "./color-palette.mjs";
import {
  ARCHITECTURE,
  FAMILY_SPECS,
  PALETTE_APPEARANCES,
  PALETTE_FAMILIES,
  buildPaletteTokens,
} from "./color-theme-spec.mjs";

const STYLES = "src/renderer/src/styles.css";
const FAMILY_THEMES = "src/renderer/public/color-themes.css";
const THEME_LIBRARY = "src/renderer/src/components/ThemeLibrary.css";

const MESSAGE_ACTION_HUE_ROTATION = 50;

export function paletteSelector(family, appearance) {
  if (family === "inertia") {
    return appearance === "light" ? ":root" : ':root[data-theme="dark"]';
  }
  return `:root[data-theme="${appearance}"][data-color-theme="${family}"]`;
}

export function swatchSelector(family, appearance) {
  return `.color-theme-swatch[data-color-theme="${family}"].is-${appearance}`;
}

export function buildSwatchTokens(family, appearance) {
  const tokens = Object.fromEntries(buildPaletteTokens(family, appearance));
  const arch = ARCHITECTURE[appearance];
  const spec = FAMILY_SPECS[family];
  const messageAction = oklchToHex({
    l: arch.accentL,
    c: arch.accentChroma * 0.9,
    h: (spec.accentHue + MESSAGE_ACTION_HUE_ROTATION) % 360,
  });
  return [
    ["theme-preview-canvas", tokens["app-bg"]],
    ["theme-preview-sidebar", tokens["sidebar-bg"]],
    ["theme-preview-surface", tokens["surface-strong"]],
    ["theme-preview-accent", tokens.accent],
    ["theme-preview-accent-soft", tokens["accent-soft"]],
    ["theme-preview-message-action", messageAction],
  ];
}

function replaceTokensInBlock(css, selector, tokens) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(${escaped}\\s*\\{)([\\s\\S]*?)(\\n\\})`, "u");
  const match = pattern.exec(css);
  if (!match) throw new Error(`Palette block not found: ${selector}`);
  let body = match[2];
  for (const [name, value] of tokens) {
    const declaration = new RegExp(`(\\n\\s*--${name}:\\s*)([^;]+)(;)`, "u");
    if (!declaration.test(body)) {
      throw new Error(`Token --${name} is not declared in ${selector}`);
    }
    body = body.replace(declaration, `$1${value}$3`);
  }
  return css.slice(0, match.index)
    + match[1] + body + match[3]
    + css.slice(match.index + match[0].length);
}

export function renderFiles(read) {
  let styles = read(STYLES);
  let familyThemes = read(FAMILY_THEMES);
  let themeLibrary = read(THEME_LIBRARY);

  for (const family of PALETTE_FAMILIES) {
    for (const appearance of PALETTE_APPEARANCES) {
      const tokens = buildPaletteTokens(family, appearance);
      const selector = paletteSelector(family, appearance);
      if (family === "inertia") {
        styles = replaceTokensInBlock(styles, selector, tokens);
      } else {
        familyThemes = replaceTokensInBlock(familyThemes, selector, tokens);
      }
      themeLibrary = replaceTokensInBlock(
        themeLibrary,
        swatchSelector(family, appearance),
        buildSwatchTokens(family, appearance),
      );
    }
  }
  return {
    [STYLES]: styles,
    [FAMILY_THEMES]: familyThemes,
    [THEME_LIBRARY]: themeLibrary,
  };
}

export function windowBackground(appearance) {
  return Object.fromEntries(buildPaletteTokens("inertia", appearance))["app-bg"];
}

function main() {
  const check = process.argv.includes("--check");
  const rendered = renderFiles((path) => readFileSync(path, "utf8"));
  let drifted = 0;
  for (const [path, next] of Object.entries(rendered)) {
    const current = readFileSync(path, "utf8");
    if (current === next) continue;
    drifted += 1;
    if (check) console.error(`drift: ${path}`);
    else {
      writeFileSync(path, next);
      console.log(`updated: ${path}`);
    }
  }
  if (check && drifted > 0) {
    console.error("Run `npm run generate:color-themes` to refresh generated palettes.");
    process.exit(1);
  }
  if (!check && drifted === 0) console.log("palettes already current");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
