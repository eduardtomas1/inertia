import {
  contrastRatio,
  hexToRgb,
  maxChromaAt,
  oklchToHex,
  solveLightness,
} from "./color-palette.mjs";

export const PALETTE_FAMILIES = ["inertia", "grove", "ocean", "ember", "iris"];
export const PALETTE_APPEARANCES = ["light", "dark"];

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
    direction: "darker",
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
    direction: "lighter",
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
    borderAlpha: 0.10,
    borderStrongAlpha: 0.17,
    panelBorderAlpha: 0.13,
    codeBorderAlpha: 0.14,
    glassChromeAlpha: 0.88,
    glassFloatAlpha: 0.94,
  },
};

export const FAMILY_SPECS = {
  inertia: { neutralHue: 286, accentHue: 283, neutralTint: 1.0 },
  grove: { neutralHue: 152, accentHue: 157, neutralTint: 3.2 },
  ocean: { neutralHue: 232, accentHue: 235, neutralTint: 3.2 },
  ember: { neutralHue: 44, accentHue: 32, neutralTint: 3.2 },
  iris: { neutralHue: 294, accentHue: 292, neutralTint: 3.2 },
};

export const BASE_NEUTRAL_CHROMA = { light: 0.004, dark: 0.005 };

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildPaletteTokens(family, appearance) {
  const spec = FAMILY_SPECS[family];
  const arch = ARCHITECTURE[appearance];
  const hue = spec.neutralHue;
  const neutralChroma = BASE_NEUTRAL_CHROMA[appearance] * spec.neutralTint;
  const neutral = (l, chroma = neutralChroma) =>
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

  const status = (statusHue, chromaCap = arch.statusChroma) => solveLightness({
    hue: statusHue,
    chromaCap,
    backgrounds: surfaceList,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.statusStartL,
  }).hex;

  const accent = oklchToHex({
    l: arch.accentL,
    c: maxChromaAt(arch.accentL, spec.accentHue, arch.accentChroma),
    h: spec.accentHue,
  });
  const accentStrong = oklchToHex({
    l: arch.accentStrongL,
    c: maxChromaAt(arch.accentStrongL, spec.accentHue, arch.accentChroma),
    h: spec.accentHue,
  });
  const accentTextCandidate = oklchToHex({
    l: arch.accentTextL,
    c: arch.accentTextChroma,
    h: spec.accentHue,
  });
  const accentText = contrastRatio(accentTextCandidate, accent) >= 4.6
    ? accentTextCandidate
    : (appearance === "light" ? "#ffffff" : "#000000");

  const codeSurface = neutral(arch.codeSurfaceL);
  const inlineCode = neutral(arch.inlineCodeL);
  const syntaxOn = (syntaxHue, chromaCap = arch.syntaxChroma) => solveLightness({
    hue: syntaxHue,
    chromaCap,
    backgrounds: [codeSurface, inlineCode],
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.statusStartL,
  }).hex;

  const activeRest = solveLightness({
    hue: spec.accentHue,
    chromaCap: arch.statusChroma * arch.activeChromaScale,
    backgrounds: surfaceList,
    target: arch.statusTarget,
    direction: arch.direction,
    startL: arch.activeRestL,
  }).hex;
  const activeHighlight = solveLightness({
    hue: spec.accentHue,
    chromaCap: arch.statusChroma * arch.activeChromaScale,
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
      c: maxChromaAt(arch.accentHoverL, spec.accentHue, arch.accentChroma),
      h: spec.accentHue,
    })],
    ["accent-soft", oklchToHex({
      l: arch.accentSoftL,
      c: arch.accentSoftChroma,
      h: spec.accentHue,
    })],
    ["accent-text", accentText],
    ["accent-strong", accentStrong],
    ["code-surface", codeSurface],
    ["code-header-surface", neutral(arch.codeHeaderL)],
    ["code-border", rgba(text, arch.codeBorderAlpha)],
    ["inline-code-surface", inlineCode],
    ["terminal-bg", neutral(arch.terminalBgL)],
    ["terminal-fg", neutral(arch.terminalFgL, neutralChroma * 2)],
    ["terminal-selection", oklchToHex({
      l: arch.terminalSelectionL,
      c: arch.terminalSelectionChroma,
      h: spec.accentHue,
    })],
    ["glass-chrome", rgba(
      appearance === "light" ? surfaces.surface : surfaces["sidebar-bg"],
      arch.glassChromeAlpha,
    )],
    ["glass-float", rgba(surfaces["surface-strong"], arch.glassFloatAlpha)],
    ["active-work-text-rest", activeRest],
    ["active-work-text-highlight", activeHighlight],
    ["syntax-keyword", syntaxOn(spec.accentHue, arch.syntaxChroma * 1.25)],
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
    ["status-input", status(spec.accentHue, arch.statusChroma * 1.2)],
    ["status-failed", status(SEMANTIC_HUES.danger)],
    ["status-completed", status(SEMANTIC_HUES.success)],
    ["ultra-sweep", oklchToHex({
      l: arch.ultraSweepL,
      c: maxChromaAt(arch.ultraSweepL, SEMANTIC_HUES.info, arch.ultraSweepChroma),
      h: SEMANTIC_HUES.info,
    })],
  ];
}
