import {
  contrastRatio,
  gamutMapChroma,
  hexToRgb,
  hexToOklch,
  maxChromaAt,
  oklchToHex,
  solveLightness,
} from "./color-palette.ts";

export const PALETTE_FAMILIES = ["inertia", "grove", "ocean", "ember", "iris"] as const;
export type PaletteFamily = typeof PALETTE_FAMILIES[number];
export type PaletteAppearance = "light" | "dark";
interface FamilySpec {
  neutralHue: number;
  accentHue: number;
  neutralTint: number;
  auroraHues: readonly number[];
  chromaScale?: number;
  mute?: number;
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
    textTarget: 7.0,
    softTarget: 5.6,
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
    softTintL: 0.910,
    softTintChroma: 0.030,
    codeSurfaceL: 0.974,
    codeHeaderL: 0.946,
    inlineCodeL: 0.938,
    terminalBgL: 0.992,
    terminalFgL: 0.270,
    terminalSelectionL: 0.885,
    terminalSelectionChroma: 0.042,
    syntaxChroma: 0.115,
    syntaxNeutralChroma: 0.012,
    activeRestL: 0.500,
    activeHighlightL: 0.300,
    activeChromaScale: 0.55,
    ultraSweepL: 0.560,
    ultraSweepChroma: 0.100,
    auroraL: 0.780,
    auroraChroma: 0.130,
    borderAlpha: 0.15,
    borderStrongAlpha: 0.25,
    panelBorderAlpha: 0.21,
    codeBorderAlpha: 0.20,
    glassChromeAlpha: 0.78,
    glassFloatAlpha: 0.88,
  },
  dark: {
    ladder: {
      "app-bg": 0.118,
      "sidebar-bg": 0.149,
      surface: 0.180,
      "surface-strong": 0.211,
      "surface-muted": 0.242,
      "surface-hover": 0.273,
    },
    direction: "lighter" as const,
    textL: 0.950,
    textTarget: 7.0,
    softTarget: 5.6,
    mutedTarget: 4.6,
    statusTarget: 4.6,
    statusStartL: 0.745,
    statusChroma: 0.110,
    accentL: 0.750,
    accentChroma: 0.140,
    accentHoverL: 0.800,
    accentStrongL: 0.830,
    accentSoftL: 0.255,
    accentSoftChroma: 0.040,
    accentTextL: 0.145,
    accentTextChroma: 0.020,
    softTintL: 0.245,
    softTintChroma: 0.034,
    codeSurfaceL: 0.146,
    codeHeaderL: 0.184,
    inlineCodeL: 0.230,
    terminalBgL: 0.132,
    terminalFgL: 0.920,
    terminalSelectionL: 0.320,
    terminalSelectionChroma: 0.046,
    syntaxChroma: 0.110,
    syntaxNeutralChroma: 0.014,
    activeRestL: 0.620,
    activeHighlightL: 0.930,
    activeChromaScale: 0.55,
    ultraSweepL: 0.800,
    ultraSweepChroma: 0.090,
    auroraL: 0.640,
    auroraChroma: 0.160,
    borderAlpha: 0.10,
    borderStrongAlpha: 0.17,
    panelBorderAlpha: 0.13,
    codeBorderAlpha: 0.14,
    glassChromeAlpha: 0.88,
    glassFloatAlpha: 0.94,
  },
};

// Aurora hues start at the family accent and add two analogous neighbours, so
// the sidebar light reads as the theme itself rather than a fixed rainbow.
export const FAMILY_SPECS = {
  inertia: { neutralHue: 286, accentHue: 283, neutralTint: 1.0, auroraHues: [283, 236, 322] },
  grove: { neutralHue: 152, accentHue: 157, neutralTint: 3.2, auroraHues: [157, 192, 132] },
  ocean: { neutralHue: 232, accentHue: 235, neutralTint: 3.2, auroraHues: [235, 266, 198] },
  ember: { neutralHue: 44, accentHue: 32, neutralTint: 3.2, auroraHues: [32, 58, 356] },
  iris: { neutralHue: 294, accentHue: 292, neutralTint: 3.2, auroraHues: [292, 262, 332] },
};

export const BASE_NEUTRAL_CHROMA = { light: 0.004, dark: 0.005 };

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

  const text = neutral(arch.textL, neutralChroma * 2.5);
  const textSoft = solveLightness({
    hue,
    chromaCap: arch.syntaxNeutralChroma,
    backgrounds: [worstSurface],
    target: arch.softTarget,
    direction: arch.direction,
    startL: appearance === "light" ? 0.38 : 0.82,
  });
  const textMuted = solveLightness({
    hue,
    chromaCap: arch.syntaxNeutralChroma,
    backgrounds: [worstSurface],
    target: arch.mutedTarget,
    direction: arch.direction,
    startL: appearance === "light" ? 0.50 : 0.70,
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

  const codeSurface = neutral(arch.codeSurfaceL);
  const inlineCode = neutral(arch.inlineCodeL);
  const syntaxOn = (syntaxHue: number, chromaCap = arch.syntaxChroma) => solveLightness({
    hue: syntaxHue,
    chromaCap,
    backgrounds: [codeSurface, inlineCode],
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.statusStartL,
  }).hex;

  const activeRest = solveLightness({
    hue: spec.accentHue,
    chromaCap: arch.statusChroma * arch.activeChromaScale * tint,
    backgrounds: surfaceList,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.activeRestL,
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
    ["text-soft", textSoft.hex],
    ["text-muted", textMuted.hex],
    ["border", rgba(text, arch.borderAlpha)],
    ["border-strong", rgba(text, arch.borderStrongAlpha)],
    ["panel-border", rgba(text, arch.panelBorderAlpha)],
    ["accent", accent],
    ["accent-hover", oklchToHex({
      l: arch.accentHoverL,
      c: maxChromaAt(arch.accentHoverL, spec.accentHue, (arch.accentChroma * chromaScale)) * mute,
      h: spec.accentHue,
    })],
    ["accent-soft", oklchToHex({
      l: arch.accentSoftL,
      c: muted(arch.accentSoftL, arch.accentSoftChroma * chromaScale, spec.accentHue),
      h: spec.accentHue,
    })],
    ["accent-text", accentText],
    ["accent-strong", accentStrong],
    ["message-action", oklchToHex({
      l: arch.accentL,
      c: muted(arch.accentL, (arch.accentChroma * chromaScale) * 0.9, (spec.accentHue + 50) % 360),
      h: (spec.accentHue + 50) % 360,
    })],
    ["code-surface", codeSurface],
    ["code-header-surface", neutral(arch.codeHeaderL)],
    ["code-border", rgba(text, arch.codeBorderAlpha)],
    ["inline-code-surface", inlineCode],
    ["terminal-bg", neutral(arch.terminalBgL)],
    ["terminal-fg", neutral(arch.terminalFgL, neutralChroma * 2)],
    ["terminal-selection", oklchToHex({
      l: arch.terminalSelectionL,
      c: muted(arch.terminalSelectionL, arch.terminalSelectionChroma * chromaScale, spec.accentHue),
      h: spec.accentHue,
    })],
    ["glass-chrome", rgba(
      appearance === "light" ? surfaces.surface : surfaces["sidebar-bg"],
      arch.glassChromeAlpha,
    )],
    ["glass-float", rgba(surfaces["surface-strong"], arch.glassFloatAlpha)],
    ["active-work-text-rest", activeRest],
    ["active-work-text-highlight", activeHighlight],
    ["syntax-keyword", syntaxOn(spec.accentHue, arch.syntaxChroma * 1.25 * tint)],
    ["syntax-string", syntaxOn(SEMANTIC_HUES.success)],
    ["syntax-number", syntaxOn(SEMANTIC_HUES.number)],
    ["syntax-function", syntaxOn(SEMANTIC_HUES.code)],
    ["syntax-variable", syntaxOn(hue, arch.syntaxNeutralChroma)],
    ["syntax-comment", solveLightness({
      hue,
      chromaCap: arch.syntaxNeutralChroma,
      backgrounds: [codeSurface, inlineCode],
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
    // One OKLCH lightness for all three hues keeps the drifting light even:
    // no hue flares brighter or sinks muddier than its neighbours.
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
  const { h, c } = hexToOklch(hex);
  const chromaScale = c < 0.004 ? 0 : Math.min(c / 0.1, 1);
  const mute = muted ? MUTED_CHROMA_SCALE : 1;
  return buildTokens({
    neutralHue: h,
    accentHue: h,
    neutralTint: 3.2 * chromaScale * mute,
    chromaScale,
    mute,
    auroraHues: [h, (h + 325) % 360, (h + 35) % 360],
  }, appearance);
}
