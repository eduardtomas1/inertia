import {
  contrastRatio,
  gamutMapChroma,
  hexToRgb,
  hexToOklch,
  maxChromaAt,
  oklchToHex,
  solveLightness,
} from "./color-palette.ts";

export const PALETTE_FAMILIES = ["inertia", "grove", "ocean", "ember", "iris", "graphite", "blossom", "lagoon", "saffron"] as const;
export type PaletteFamily = typeof PALETTE_FAMILIES[number];
export type PaletteAppearance = "light" | "dark";
interface FamilySpec {
  neutralHue: number;
  accentHue: number;
  neutralTint: number;
  auroraHues: readonly number[];
  chromaScale?: number;
  mute?: number;
  seed?: AccentSeed | Partial<Record<PaletteAppearance, AccentSeed>>;
}

interface AccentSeed { l: number; c: number }

interface AccentRoles { accent: string; accentHover: string; accentStrong: string; accentText: string }

interface AccentFillSpec { textL: number; textChroma: number; chroma: number; target: number; hoverShift: number }

interface AccentFillRoles { fill: string; fillHover: string; fillText: string }

function solvedAccentFill(fill: AccentFillSpec, hue: number, chromaCap: number, text: string): AccentFillRoles {
  const build = (l: number) => oklchToHex({ l, c: maxChromaAt(l, hue, chromaCap), h: hue });
  let low = 0.2;
  let high = 0.8;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (contrastRatio(text, build(mid)) >= fill.target) low = mid;
    else high = mid;
  }
  return { fill: build(low), fillHover: build(low - fill.hoverShift), fillText: text };
}

function seededAccents(
  seed: { l: number; c: number },
  hue: number,
  appearance: PaletteAppearance,
  guards: readonly string[],
  textCandidates: readonly string[],
): AccentRoles {
  const arch = ARCHITECTURE[appearance];
  const build = (l: number) => oklchToHex({ l, c: seed.c, h: hue });
  const nearest = (target: number) => {
    const clears = (l: number) => guards.every((background) => contrastRatio(build(l), background) >= target);
    if (clears(seed.l)) return seed.l;
    let low = seed.l;
    let high = arch.direction === "darker" ? 0 : 1;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (clears(mid)) high = mid;
      else low = mid;
    }
    return high;
  };
  const accentL = nearest(3);
  const accent = build(accentL);
  const textOn = (fill: string) => textCandidates.find((candidate) => contrastRatio(candidate, fill) >= 4.6)
    ?? (contrastRatio("#ffffff", fill) >= contrastRatio("#000000", fill) ? "#ffffff" : "#000000");
  const accentText = textOn(accent);
  const lighterText = contrastRatio(accentText, "#ffffff") < contrastRatio(accentText, "#000000");
  const accentHover = build(Math.min(1, Math.max(0, accentL + (lighterText ? -0.05 : 0.05))));
  return {
    accent,
    accentHover,
    accentStrong: build(nearest(4.5)),
    accentText: contrastRatio(accentText, accentHover) >= 4.6 ? accentText : textOn(accentHover),
  };
}
export const PALETTE_APPEARANCES = ["light", "dark"] as const;

export const SEMANTIC_HUES = {
  danger: 26,
  warning: 70,
  success: 155,
  info: 234,
  magenta: 331,
  java: 50,
  number: 63,
  code: 242,
};

export const ARCHITECTURE = {
  light: {
    ladder: {
      "surface-strong": 0.986,
      surface: 0.964,
      "app-bg": 0.942,
      "sidebar-bg": 0.920,
      "surface-muted": 0.898,
      "surface-hover": 0.876,
    },
    direction: "darker" as const,
    textL: 0.250,
    textChromaCap: 0.032,
    textTarget: 7.0,
    mutedTarget: 4.6,
    statusTarget: 4.6,
    statusStartL: 0.520,
    statusChroma: 0.115,
    accentL: 0.450,
    accentChroma: 0.215,
    accentHoverL: 0.400,
    accentStrongL: 0.355,
    accentSoftL: 0.915,
    accentSoftChroma: 0.038,
    accentTextL: 0.995,
    accentTextChroma: 0.004,
    accentFill: null as AccentFillSpec | null,
    softTintL: 0.910,
    softTintChroma: 0.030,
    terminalBgL: 0.992,
    terminalFgL: 0.270,
    terminalSelectionL: 0.885,
    terminalSelectionChroma: 0.042,
    syntaxChroma: 0.115,
    syntaxNeutralChroma: 0.012,
    activeHighlightL: 0.300,
    activeChromaScale: 0.55,
    ultraSweepL: 0.560,
    ultraSweepChroma: 0.100,
    auroraL: 0.780,
    auroraChroma: 0.130,
  },
  dark: {
    ladder: {
      "app-bg": 0.185,
      "sidebar-bg": 0.237,
      surface: 0.159,
      "surface-strong": 0.211,
      "surface-muted": 0.263,
      "surface-hover": 0.295,
    },
    direction: "lighter" as const,
    textL: 0.950,
    textChromaCap: 0.014,
    textTarget: 7.0,
    mutedTarget: 4.6,
    statusTarget: 4.6,
    statusStartL: 0.745,
    statusChroma: 0.110,
    accentL: 0.710,
    accentChroma: 0.170,
    accentHoverL: 0.760,
    accentStrongL: 0.830,
    accentSoftL: 0.300,
    accentSoftChroma: 0.050,
    accentTextL: 0.145,
    accentTextChroma: 0.020,
    accentFill: { textL: 0.985, textChroma: 0.008, chroma: 0.200, target: 4.6, hoverShift: 0.040 } as AccentFillSpec | null,
    softTintL: 0.290,
    softTintChroma: 0.040,
    terminalBgL: 0.132,
    terminalFgL: 0.920,
    terminalSelectionL: 0.400,
    terminalSelectionChroma: 0.064,
    syntaxChroma: 0.110,
    syntaxNeutralChroma: 0.014,
    activeHighlightL: 0.930,
    activeChromaScale: 0.55,
    ultraSweepL: 0.800,
    ultraSweepChroma: 0.090,
    auroraL: 0.640,
    auroraChroma: 0.160,
  },
};

export const FAMILY_SPECS = {
  inertia: { neutralHue: 286, accentHue: 283, neutralTint: 1.0, auroraHues: [283, 236, 322] },
  grove: { neutralHue: 152, accentHue: 157, neutralTint: 3.2, auroraHues: [157, 192, 132] },
  ocean: { neutralHue: 232, accentHue: 235, neutralTint: 3.2, auroraHues: [235, 266, 198] },
  ember: { neutralHue: 44, accentHue: 32, neutralTint: 3.2, auroraHues: [32, 58, 356] },
  iris: { neutralHue: 294, accentHue: 292, neutralTint: 3.2, auroraHues: [292, 262, 332] },
  graphite: { neutralHue: 250, accentHue: 263, neutralTint: 0.7, auroraHues: [263, 236, 292] },
  blossom: { neutralHue: 320, accentHue: 356, neutralTint: 3.0, auroraHues: [356, 322, 28], seed: { light: { l: 0.54, c: 0.2 } } },
  lagoon: { neutralHue: 200, accentHue: 192, neutralTint: 2.8, auroraHues: [192, 162, 226], seed: { light: { l: 0.5, c: 0.1 } } },
  saffron: { neutralHue: 80, accentHue: 80, neutralTint: 2.4, auroraHues: [80, 50, 24], seed: { light: { l: 0.58, c: 0.13 } } },
};

export const BASE_NEUTRAL_CHROMA = { light: 0.004, dark: 0.005 };

export const FILL_INK = 0.04;

export function inkOver(ink: string, background: string, amount: number): string {
  const top = hexToRgb(ink);
  return `#${hexToRgb(background).map((channel, index) => Math.round(top[index]! * amount + channel * (1 - amount))
    .toString(16).padStart(2, "0")).join("")}`;
}

export function buildPaletteTokens(family: PaletteFamily, appearance: PaletteAppearance): (readonly [string, string])[] {
  return buildTokens(FAMILY_SPECS[family], appearance);
}

function buildTokens(spec: FamilySpec, appearance: PaletteAppearance): (readonly [string, string])[] {
  const chromaScale = spec.chromaScale ?? 1;
  const mute = spec.mute ?? 1;
  const tint = chromaScale * mute;
  const muted = (l: number, c: number, h: number): number =>
    mute === 1 ? c : gamutMapChroma({ l, c, h }).c * mute;
  const arch = ARCHITECTURE[appearance];
  const hue = spec.neutralHue;
  const neutralChroma = BASE_NEUTRAL_CHROMA[appearance] * spec.neutralTint;
  const neutral = (l: number, chroma = neutralChroma) =>
    oklchToHex({ l, c: chroma, h: hue });

  const surfaces = Object.fromEntries(
    Object.entries(arch.ladder).map(([role, l]) => [role, neutral(l)]),
  );
  const surfaceList = Object.values(surfaces);
  const worstSurface = appearance === "light"
    ? surfaces["surface-hover"]
    : surfaces["surface-hover"];

  const text = neutral(arch.textL, Math.min(neutralChroma * 2.5, arch.textChromaCap));
  const textMuted = solveLightness({
    hue,
    chromaCap: arch.syntaxNeutralChroma,
    backgrounds: [worstSurface],
    target: arch.mutedTarget,
    direction: arch.direction,
    startL: appearance === "light" ? 0.50 : 0.72,
  });

  const status = (statusHue: number, chromaCap = arch.statusChroma) => solveLightness({
    hue: statusHue,
    chromaCap,
    backgrounds: surfaceList,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.statusStartL,
  }).hex;

  const accent = oklchToHex({
    l: arch.accentL,
    c: maxChromaAt(arch.accentL, spec.accentHue, (arch.accentChroma * chromaScale)) * mute,
    h: spec.accentHue,
  });
  const accentStrong = oklchToHex({
    l: arch.accentStrongL,
    c: maxChromaAt(arch.accentStrongL, spec.accentHue, (arch.accentChroma * chromaScale)) * mute,
    h: spec.accentHue,
  });
  const accentTextCandidate = oklchToHex({
    l: arch.accentTextL,
    c: muted(arch.accentTextL, arch.accentTextChroma * chromaScale, spec.accentHue),
    h: spec.accentHue,
  });
  const accentText = contrastRatio(accentTextCandidate, accent) >= 4.6
    ? accentTextCandidate
    : (appearance === "light" ? "#ffffff" : "#000000");
  const terminalBg = neutral(arch.terminalBgL);
  const accentHover = oklchToHex({
    l: arch.accentHoverL,
    c: maxChromaAt(arch.accentHoverL, spec.accentHue, (arch.accentChroma * chromaScale)) * mute,
    h: spec.accentHue,
  });
  const opposite = ARCHITECTURE[appearance === "light" ? "dark" : "light"];
  const seed = spec.seed && ("l" in spec.seed ? spec.seed : spec.seed[appearance]);
  const accents: AccentRoles = seed
    ? seededAccents({ l: seed.l, c: seed.c * mute }, spec.accentHue, appearance,
      [surfaces["app-bg"], surfaces["sidebar-bg"], surfaces.surface, surfaces["surface-strong"], terminalBg],
      [accentTextCandidate, oklchToHex({
        l: opposite.accentTextL,
        c: muted(opposite.accentTextL, opposite.accentTextChroma * chromaScale, spec.accentHue),
        h: spec.accentHue,
      })])
    : { accent, accentHover, accentStrong, accentText };
  const fills: AccentFillRoles = arch.accentFill
    ? solvedAccentFill(arch.accentFill, spec.accentHue, seed ? seed.c * mute : arch.accentFill.chroma * tint, oklchToHex({
      l: arch.accentFill.textL,
      c: muted(arch.accentFill.textL, arch.accentFill.textChroma * chromaScale, spec.accentHue),
      h: spec.accentHue,
    }))
    : { fill: accents.accent, fillHover: accents.accentHover, fillText: accents.accentText };

  const raised = appearance === "light" ? "#ffffff" : surfaces["surface-muted"];
  const codeBackgrounds = [surfaces.surface, surfaces["surface-strong"], raised]
    .map((background) => inkOver(text, background, FILL_INK));
  const syntaxOn = (syntaxHue: number, chromaCap = arch.syntaxChroma) => solveLightness({
    hue: syntaxHue,
    chromaCap,
    backgrounds: codeBackgrounds,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.statusStartL,
  }).hex;

  const activeHighlight = solveLightness({
    hue: spec.accentHue,
    chromaCap: arch.statusChroma * arch.activeChromaScale * tint,
    backgrounds: surfaceList,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.activeHighlightL,
  }).hex;

  return [
    ["app-bg", surfaces["app-bg"]],
    ["sidebar-bg", surfaces["sidebar-bg"]],
    ["surface", surfaces.surface],
    ["surface-strong", surfaces["surface-strong"]],
    ["surface-muted", surfaces["surface-muted"]],
    ["surface-hover", surfaces["surface-hover"]],
    ["text", text],
    ["text-muted", textMuted.hex],
    ["accent", accents.accent],
    ["accent-hover", accents.accentHover],
    ["accent-soft", oklchToHex({
      l: arch.accentSoftL,
      c: muted(arch.accentSoftL, arch.accentSoftChroma * chromaScale, spec.accentHue),
      h: spec.accentHue,
    })],
    ["accent-text", accents.accentText],
    ["accent-strong", accents.accentStrong],
    ["accent-fill", fills.fill],
    ["accent-fill-hover", fills.fillHover],
    ["accent-fill-text", fills.fillText],
    ["terminal-bg", terminalBg],
    ["terminal-fg", neutral(arch.terminalFgL, Math.min(neutralChroma * 2, arch.textChromaCap))],
    ["terminal-selection", oklchToHex({
      l: arch.terminalSelectionL,
      c: muted(arch.terminalSelectionL, arch.terminalSelectionChroma * chromaScale, spec.accentHue),
      h: spec.accentHue,
    })],
    ["active-work-text-highlight", activeHighlight],
    ["syntax-keyword", syntaxOn(spec.accentHue, arch.syntaxChroma * 1.25 * tint)],
    ["syntax-string", syntaxOn(SEMANTIC_HUES.success)],
    ["syntax-number", syntaxOn(SEMANTIC_HUES.number)],
    ["syntax-function", syntaxOn(SEMANTIC_HUES.code)],
    ["syntax-variable", syntaxOn(hue, arch.syntaxNeutralChroma)],
    ["syntax-comment", solveLightness({
      hue,
      chromaCap: arch.syntaxNeutralChroma,
      backgrounds: codeBackgrounds,
      target: arch.mutedTarget,
      direction: arch.direction,
      startL: appearance === "light" ? 0.52 : 0.66,
    }).hex],
    ["syntax-meta", syntaxOn(SEMANTIC_HUES.magenta)],
    ["syntax-deletion", syntaxOn(SEMANTIC_HUES.danger)],
    ["language-java", syntaxOn(SEMANTIC_HUES.java)],
    ["danger", status(SEMANTIC_HUES.danger)],
    ["danger-soft", oklchToHex({
      l: arch.softTintL,
      c: arch.softTintChroma,
      h: SEMANTIC_HUES.danger,
    })],
    ["warning", status(SEMANTIC_HUES.warning)],
    ["blue", status(SEMANTIC_HUES.info)],
    ["status-working", status(SEMANTIC_HUES.info)],
    ["status-approval", status(SEMANTIC_HUES.warning)],
    ["status-input", status(spec.accentHue, arch.statusChroma * 1.2 * tint)],
    ["status-failed", status(SEMANTIC_HUES.danger)],
    ["status-completed", status(SEMANTIC_HUES.success)],
    ["ultra-sweep", oklchToHex({
      l: arch.ultraSweepL,
      c: maxChromaAt(arch.ultraSweepL, SEMANTIC_HUES.info, arch.ultraSweepChroma),
      h: SEMANTIC_HUES.info,
    })],
    ...spec.auroraHues.map((auroraHue, index): readonly [string, string] => [`aurora-${index + 1}`, oklchToHex({
      l: arch.auroraL,
      c: maxChromaAt(arch.auroraL, auroraHue, (arch.auroraChroma * chromaScale)) * mute,
      h: auroraHue,
    })]),
  ];
}

export const MUTED_CHROMA_SCALE = 0.5;

export function buildCustomPaletteTokens(hex: string, appearance: PaletteAppearance, muted = false): (readonly [string, string])[] {
  if (!/^#[0-9a-f]{6}$/iu.test(hex)) throw new Error("Expected a six-digit hex color.");
  const { l, h, c } = hexToOklch(hex);
  const chromaScale = c < 0.004 ? 0 : Math.min(c / 0.1, 1);
  const mute = muted ? MUTED_CHROMA_SCALE : 1;
  return buildTokens({
    neutralHue: h,
    accentHue: h,
    neutralTint: 3.2 * chromaScale * mute,
    chromaScale,
    mute,
    seed: { l, c: c < 0.004 ? 0 : c },
    auroraHues: [h, (h + 325) % 360, (h + 35) % 360],
  }, appearance);
}
