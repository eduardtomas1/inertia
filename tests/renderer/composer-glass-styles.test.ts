import { Window } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";

import { createCascade } from "./css-cascade";
import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const SUPPORTS = "@supports (backdrop-filter: blur(1px))";
const REDUCED = "@media (prefers-reduced-motion: reduce)";
const OPT_OUT = "@media (prefers-reduced-transparency: reduce), (forced-colors: active)";
const NARROW_SEND = "@container (max-width: 420px)";
const styles = readRendererCss("styles.css");
const surface = readRendererCss("components/composer/ComposerSurface.css");
const sendActions = readRendererCss("components/composer/ComposerSendActions.css");
const tasks = readRendererCss("components/TasksView.css");
const all = [styles, surface, sendActions, tasks].join("\n");
const rules = parseCssRules(all);
const surfaceRules = parseCssRules(surface);
const STOP = '.composer-shell .composer-input-actions .send-button:is([data-composer-action-state="stop-ready"], [data-composer-action-state="stop-pending"])';
const CHIP = ".composer-shell .composer-setting-family .composer-pill";
const LABELLED_SEND_HOVER = ".composer-shell .composer-input-actions .send-button.has-label:not(:disabled):hover";

function whereList(context: string): string[] {
  const rule = rules.find(({ context: ruleContext, selectors }) =>
    ruleContext === context && selectors.length === 1 && selectors[0]!.startsWith(":where("));
  expect(rule, `${context} :where() rule`).toBeDefined();
  return rule!.selectors[0]!.slice(":where(".length, -1).split(",").map((entry) => entry.trim());
}

function keyframeProperties(): Map<string, Set<string>> {
  const frames = new Map<string, Set<string>>();
  const source = all.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of source.matchAll(/@keyframes (?<name>[\w-]+) \{/gu)) {
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
    }
    const body = source.slice(match.index + match[0].length, index);
    frames.set(match.groups!.name!, new Set([...body.matchAll(/(?<property>[\w-]+)\s*:/gu)].map(({ groups }) => groups!.property!)));
  }
  return frames;
}

function subject(selector: string): string {
  return selector.split(/\s*[\s>+~]\s*(?![^(]*\))/u).at(-1) ?? selector;
}

describe("glass floating layers", () => {
  it("paints the composer surface and its queue solid, with no glass and no backdrop blur", () => {
    const selector = ".composer-shell .composer > .composer-surface";
    const solid = declarationsFor(rules, selector);
    expect([solid.get("background"), solid.get("box-shadow"), solid.get("border-radius")])
      .toEqual(["var(--surface-raised)", "var(--shadow-float)", "var(--radius-lg)"]);
    expect(declarationsFor(rules, ".composer-queue").get("background")).toBe("var(--surface-raised)");
    for (const layer of [selector, ".composer-queue", ".composer-shell .composer", ".composer"]) {
      for (const rule of rules.filter(({ selectors }) => selectors.includes(layer))) {
        expect(rule.declarations.has("backdrop-filter"), `${rule.context} ${layer}`).toBe(false);
        expect(rule.declarations.get("background") ?? "", `${rule.context} ${layer}`).not.toContain("--glass");
      }
    }
    expect(surface).not.toMatch(/--glass|backdrop-filter/u);
    expect(sendActions).not.toMatch(/--glass|backdrop-filter/u);
  });

  it("puts the palette, dialogs, menus, popovers and toasts on glass and keeps tooltips, the composer and the model chooser solid", () => {
    const list = whereList(SUPPORTS);
    for (const layer of [
      ".command-palette",
      ".dialog-shell",
      ".provider-auth-dialog",
      ".composer-popover",
      ".composer-command-menu",
      ".composer-suggestion-menu",
      ".conversation-menu",
      ".header-popover",
      ".project-menu",
      ".thread-submenu",
      ".usage-popover",
      ".error-toast",
      ".database-recovery-notice",
      ".provider-quota-notice",
    ]) expect(list, layer).toContain(layer);
    for (const solid of [".tooltip", ".model-chooser-palette", ".composer", ".composer-surface", ".composer-queue"]) {
      expect(list).not.toContain(solid);
    }
    const glass = rules.find(({ context, selectors }) => context === SUPPORTS && selectors[0]!.startsWith(":where("))!.declarations;
    expect(glass.get("background")).toBe("var(--glass-surface)");
    expect(glass.get("backdrop-filter")).toBe("var(--glass-filter)");
    expect(glass.get("border")).toBe("var(--glass-edge)");
    expect([glass.get("--fill"), glass.get("--fill-strong")]).toEqual(["var(--fill-raised)", "var(--fill-strong-raised)"]);
    const toastFills = declarationsFor(rules, ".tasks-toast", SUPPORTS);
    expect([toastFills.get("--fill"), toastFills.get("--fill-strong")]).toEqual(["var(--fill-raised)", "var(--fill-strong-raised)"]);
    expect(declarationsFor(rules, ".tooltip").get("background")).toBe("var(--surface-raised)");
    expect([...styles.matchAll(/^\s+(?<declaration>(?:-webkit-)?backdrop-filter: [^;{]+;)/gmu)].map((match) => match.groups!.declaration))
      .toEqual(["-webkit-backdrop-filter: blur(6px);", "backdrop-filter: blur(6px);", "backdrop-filter: var(--glass-filter);", "backdrop-filter: none;"]);
    const toastGlass = declarationsFor(rules, ".tasks-toast", SUPPORTS);
    expect([toastGlass.get("background"), toastGlass.get("backdrop-filter")]).toEqual(["var(--glass-surface)", "var(--glass-filter)"]);
    expect(declarationsFor(rules, ".tasks-toast").get("background")).toBe("var(--surface-raised)");
  });

  it("returns every glass layer to the solid raised surface for reduced transparency and forced colours", () => {
    expect(whereList(OPT_OUT)).toEqual(whereList(SUPPORTS));
    const optOut = rules.find(({ context, selectors }) => context === OPT_OUT && selectors[0]!.startsWith(":where("))!.declarations;
    expect([optOut.get("background"), optOut.get("backdrop-filter")]).toEqual(["var(--surface-raised)", "none"]);
    const toast = declarationsFor(rules, ".tasks-toast", OPT_OUT);
    expect([toast.get("background"), toast.get("backdrop-filter")]).toEqual(["var(--surface-raised)", "none"]);
    for (const [source, glassAt] of [[styles, `${SUPPORTS} {\n  :where(`], [tasks, `${SUPPORTS} {\n  .tasks-toast {`]] as const) {
      expect(source.indexOf(`${OPT_OUT} {`), glassAt).toBeGreaterThan(source.indexOf(glassAt));
      expect(source.indexOf(glassAt)).toBeGreaterThan(0);
    }
  });

  it("declares the glass after the solid surface rules it overrides", () => {
    const glass = styles.indexOf(`${SUPPORTS} {\n  :where(`);
    expect(glass).toBeGreaterThan(0);
    for (const base of [
      ":where(\n  .command-palette,\n  .dialog-shell,",
      ":where(.database-recovery-notice, .error-toast, .provider-quota-notice) {",
      ":where(\n  .composer-command-menu,\n  .composer-popover,",
    ]) {
      expect(styles.indexOf(base), base).toBeGreaterThan(0);
      expect(glass, base).toBeGreaterThan(styles.indexOf(base));
    }
  });

  it("fades the dialog and palette scrims by colour so the glass above them keeps blurring the window", () => {
    const frames = keyframeProperties();
    expect(frames.get("dialog-scrim-in")).toEqual(new Set(["background-color"]));
    expect(frames.get("dialog-scrim-out")).toEqual(new Set(["background-color"]));
    const scrimAnimations = rules.flatMap(({ context, selectors, declarations }) =>
      selectors.filter((selector) => /\.(?:dialog|palette)-backdrop$/u.test(selector) && declarations.has("animation"))
        .map((selector) => [context, selector, declarations.get("animation")!] as const));
    expect(scrimAnimations).toEqual([
      ["@media (prefers-reduced-motion: no-preference)", ".dialog-backdrop", "dialog-scrim-in var(--dur) var(--ease-fade) backwards"],
      ["@media (prefers-reduced-motion: no-preference)", ".dialog-presence.is-closing > .dialog-backdrop", "dialog-scrim-out var(--dur-fast) var(--ease-fade) both"],
      ["", ".palette-backdrop", "dialog-scrim-in var(--dur) var(--ease-fade) both"],
    ]);
  });

  it("never animates the opacity of an element that holds a glass layer", () => {
    const frames = keyframeProperties();
    const hosts = [
      "composer",
      "composer-more-layer",
      "composer-shell",
      "dialog-backdrop",
      "dialog-presence",
      "palette-backdrop",
      "popover-anchor",
      "provider-quota-notices",
      "tasks-toast-region",
    ];
    const checked: string[] = [];
    for (const { selectors, declarations } of rules) {
      const animation = declarations.get("animation") ?? declarations.get("animation-name");
      if (!animation) continue;
      for (const selector of selectors) {
        if (selector.includes("::")) continue;
        const target = subject(selector);
        if (!hosts.some((host) => new RegExp(String.raw`\.${host}(?![\w-])`, "u").test(target))) continue;
        const names = animation.split(/[\s,]+/u).filter((part) => frames.has(part));
        for (const name of names) {
          checked.push(name);
          expect(frames.get(name)!.has("opacity"), `${selector} runs ${name}`).toBe(false);
        }
      }
    }
    expect(checked).toEqual(expect.arrayContaining(["dialog-scrim-in", "dialog-scrim-out"]));
  });

  it("builds glass from existing colour tokens so generated and custom themes need no new colours", () => {
    expect(styles).toMatch(/--glass-surface: color-mix\(in oklab, var\(--surface-raised\) 88%, transparent\);/u);
    expect(styles).toMatch(/:root\[data-theme="dark"\] \{[^}]*--glass-surface: color-mix\(in oklab, var\(--surface-raised\) 92%, transparent\);/u);
    const values = [...styles.matchAll(/--glass-[\w-]+: (?<value>[^;]+);/gu)].map((match) => match.groups!.value!);
    expect(values.length).toBeGreaterThanOrEqual(8);
    for (const value of values) {
      expect(value).not.toMatch(/#[\da-f]{3,8}\b|rgb\(|hsl\(|oklch\(/iu);
    }
  });
});

describe("composer control chips", () => {
  const chipWindow = new Window();
  afterAll(async () => {
    await chipWindow.happyDOM.close();
  });
  const cascadedValue = createCascade([styles, surface, sendActions].join("\n"));

  it("draws settings as separate chips, 4px apart, on the 8px padding grid, with no joining dots", () => {
    expect(surface).not.toMatch(/content: "·"/u);
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-setting-family").get("gap")).toBe("4px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-options").get("gap")).toBe("4px");
    const chip = declarationsFor(surfaceRules, CHIP);
    expect([chip.get("border-radius"), chip.get("background"), chip.get("font-size"), chip.get("gap"), chip.get("padding")])
      .toEqual(["var(--radius-xs)", "transparent", "var(--text-sm)", "4px", "0 8px"]);
    expect(declarationsFor(surfaceRules, `${CHIP}:not(:disabled, [aria-expanded="true"]):hover`).get("background"))
      .toBe("var(--fill)");
    expect(declarationsFor(surfaceRules, `${CHIP}[aria-expanded="true"]`).get("background"))
      .toBe("var(--fill-strong)");
    expect(surface).not.toMatch(/composer-setting-(?:icon|chevron)[^{}]*\{[^}]*display: none/u);
    for (const [selector, size] of [
      [".composer-shell .composer-setting-family .composer-setting-icon", "14px"],
      [".composer-shell .selected-model-chip-chevron", "12px"],
    ] as const) {
      const icon = declarationsFor(surfaceRules, selector);
      expect([icon.get("width"), icon.get("height")], selector).toEqual([size, size]);
    }
    expect(surface).not.toContain(".composer-setting-chevron");
    expect(declarationsFor(surfaceRules, ".composer-shell .selected-model-chip:hover").get("border-color")).toBe("transparent");
  });

  it("keeps an open chip on the strong fill while the pointer rests on it", () => {
    const { document } = chipWindow;
    document.body.innerHTML = [
      '<div class="composer-shell"><div class="composer-setting-family">',
      '<button type="button" class="composer-pill composer-setting-trigger" aria-expanded="false"></button>',
      '<button type="button" class="composer-pill composer-setting-trigger" aria-expanded="false" disabled></button>',
      "</div></div>",
    ].join("");
    const [chip, disabled] = [...document.querySelectorAll("button")];
    const paint = (element: typeof chip, hover: boolean) => [
      cascadedValue(element!, ["background", "background-color"], hover),
      cascadedValue(element!, ["color"], hover),
    ];
    expect(paint(chip, false)).toEqual(["transparent", "var(--text-muted)"]);
    expect(paint(chip, true)).toEqual(["var(--fill)", "var(--text)"]);
    expect(paint(disabled, true)).toEqual(["transparent", "var(--text-muted)"]);
    chip!.setAttribute("aria-expanded", "true");
    expect(paint(chip, false)).toEqual(["var(--fill-strong)", "var(--text)"]);
    expect(paint(chip, true)).toEqual(["var(--fill-strong)", "var(--text)"]);
  });

  it("starts the branch line at the first toolbar glyph at every width", () => {
    const toolbar = declarationsFor(surfaceRules, ".composer-shell .composer-toolbar");
    expect(toolbar.get("--composer-strip-inset"))
      .toBe("calc(var(--composer-rail-inset) + (var(--composer-control-height) - 16px) / 2)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-primary-rail").get("padding"))
      .toBe("2px 4px 2px var(--composer-rail-inset)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-checkout-strip").get("padding"))
      .toBe("0 14px 8px var(--composer-strip-inset)");
    const narrow = "@container (max-width: 480px)";
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-toolbar", narrow).get("--composer-rail-inset")).toBe("5px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-checkout-strip", narrow).get("padding-inline"))
      .toBe("var(--composer-strip-inset) 8px");
  });
});

describe("composer send and stop", () => {
  it("grows the enabled round send on hover, presses it down, and never scales a disabled one", () => {
    const send = declarationsFor(surfaceRules, ".composer-shell .composer-input-actions .send-button");
    expect([send.get("width"), send.get("height"), send.get("border-radius")])
      .toEqual(["var(--composer-send-size)", "var(--composer-send-size)", "50%"]);
    expect(send.get("transition")).toContain("transform var(--dur) var(--ease)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-input-actions .send-button:not(:disabled, .has-label):hover").get("transform"))
      .toBe("scale(1.05)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-input-actions .send-button:not(:disabled):active").get("transform"))
      .toBe("scale(0.97)");
    const scaled = surfaceRules.filter(({ declarations }) => declarations.get("transform")?.startsWith("scale("));
    for (const rule of scaled) {
      for (const selector of rule.selectors) expect(selector).toContain(":not(:disabled");
    }
    expect(surface).toContain("--composer-send-size: max(32px, var(--composer-control-height));");
  });

  it("grows a labelled send on hover once the narrow composer folds it into the round disc", () => {
    expect(declarationsFor(surfaceRules, LABELLED_SEND_HOVER).has("transform")).toBe(false);
    expect(declarationsFor(surfaceRules, LABELLED_SEND_HOVER, NARROW_SEND).get("transform")).toBe("scale(1.05)");
    const disc = declarationsFor(parseCssRules(sendActions), ".composer-shell .composer-input-actions .send-button.has-label", NARROW_SEND);
    expect([disc.get("width"), disc.get("border-radius")]).toEqual(["var(--composer-send-size)", "50%"]);
    expect(declarationsFor(surfaceRules, LABELLED_SEND_HOVER, REDUCED).get("transform")).toBe("none");
  });

  it("draws Stop agent as a status-failed disc with a filled square in the raised surface colour", () => {
    const stop = declarationsFor(surfaceRules, STOP);
    expect([stop.get("background"), stop.get("color"), stop.get("border-color")])
      .toEqual(["var(--status-failed)", "var(--surface-raised)", "transparent"]);
    expect(declarationsFor(surfaceRules, `${STOP} .composer-send-motion-icon path`).get("fill")).toBe("currentColor");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-input-actions .send-button .composer-send-motion-icon path").get("fill"))
      .toBe("transparent");
  });

  it("drops every composer scale and transition for reduced motion", () => {
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-input-actions .send-button:not(:disabled):is(:hover, :active)", REDUCED).get("transform"))
      .toBe("none");
    for (const rule of surfaceRules.filter(({ context, declarations }) => context === "" && declarations.has("transition"))) {
      for (const selector of rule.selectors) {
        expect(declarationsFor(surfaceRules, selector, REDUCED).get("transition"), selector).toBe("none");
      }
    }
  });
});
