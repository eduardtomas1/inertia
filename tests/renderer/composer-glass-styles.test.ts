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
const queueStyles = readRendererCss("components/composer/RuntimeComposerQueuedActions.css");
const tasks = readRendererCss("components/TasksView.css");
const all = [styles, surface, sendActions, queueStyles, tasks].join("\n");
const rules = parseCssRules(all);
const surfaceRules = parseCssRules(surface);
const CHIP = ".composer-shell .composer-chip";
const SEND = ".composer-shell .composer-input-actions .send-button";

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
    expect(queueStyles).not.toMatch(/--glass|backdrop-filter/u);
  });

  it("puts the palette, dialogs, menus, popovers and toasts on glass and keeps tooltips, the composer, the model chooser and the thread menus solid", () => {
    const list = whereList(SUPPORTS);
    for (const layer of [
      ".command-palette",
      ".dialog-shell",
      ".provider-auth-dialog",
      ".composer-popover",
      ".composer-command-menu",
      ".composer-suggestion-menu",
      ".header-popover",
      ".project-menu",
      ".usage-popover",
      ".error-toast",
      ".database-recovery-notice",
      ".provider-quota-notice",
    ]) expect(list, layer).toContain(layer);
    for (const solid of [".tooltip", ".model-chooser-palette", ".composer", ".composer-surface", ".composer-queue", ".conversation-menu", ".thread-submenu"]) {
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

  it("draws every chip 4px apart with a 600 weight label in the text colour, muted 16px icons and 12px chevrons at 70%", () => {
    expect(surface).not.toMatch(/content: "·"/u);
    for (const group of [".composer-shell .composer-options", ".composer-shell .composer-setting-family"]) {
      expect(declarationsFor(surfaceRules, group).get("gap"), group).toBe("4px");
    }
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-checkout-context").get("gap")).toBe("4px");
    expect(surface).not.toMatch(/composer-checkout-context\)\s*\{\s*gap:/u);
    expect(declarationsFor(surfaceRules, `.composer-shell .composer-chip:not([data-attention="true"]) .composer-setting-icon`).get("color"))
      .toBe("var(--text-muted)");
    expect(declarationsFor(surfaceRules, ".composer-shell .selected-model-chip-glyph").get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(surfaceRules, `.composer-shell :is(.composer-chip, .composer-more-trigger)[data-attention="true"]`).get("color"))
      .toBe("var(--warning)");
    const chip = declarationsFor(surfaceRules, CHIP);
    expect([
      chip.get("border-radius"),
      chip.get("background"),
      chip.get("color"),
      chip.get("font-size"),
      chip.get("font-weight"),
      chip.get("gap"),
      chip.get("padding"),
    ]).toEqual(["var(--radius-xs)", "transparent", "var(--text)", "var(--text-sm)", "600", "4px", "0 var(--composer-chip-inset)"]);
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-toolbar").get("--composer-chip-inset")).toBe("8px");
    expect(declarationsFor(surfaceRules, `.composer-shell button.composer-chip:not(:disabled, [aria-expanded="true"]):hover`).get("background"))
      .toBe("var(--fill)");
    expect(declarationsFor(surfaceRules, `.composer-shell button.composer-chip[aria-expanded="true"]`).get("background"))
      .toBe("var(--fill-strong)");
    expect(surface).not.toMatch(/composer-setting-(?:icon|chevron)[^{}]*\{[^}]*display: none/u);
    for (const [selector, size] of [
      [".composer-shell .composer-chip .composer-setting-icon", "16px"],
      [".composer-shell .selected-model-chip-glyph > :is(.provider-brand-icon, svg)", "16px"],
      [".composer-shell .composer-chip .composer-setting-chevron", "12px"],
      [".composer-shell .selected-model-chip-chevron", "12px"],
    ] as const) {
      const icon = declarationsFor(surfaceRules, selector);
      expect([icon.get("width"), icon.get("height")], selector).toEqual([size, size]);
    }
    for (const chevron of [".composer-shell .composer-chip .composer-setting-chevron", ".composer-shell .selected-model-chip-chevron"]) {
      expect(declarationsFor(surfaceRules, chevron).get("opacity"), chevron).toBe("0.7");
    }
    expect(declarationsFor(surfaceRules, ".composer-shell .selected-model-chip-label").get("font-weight")).toBe("600");
    const model = declarationsFor(surfaceRules, ".composer-shell .selected-model-chip");
    expect([model.get("color"), model.get("background"), model.get("border-color"), model.get("padding")])
      .toEqual(["var(--text)", "transparent", "transparent", "0 var(--composer-chip-inset)"]);
    expect(declarationsFor(surfaceRules, `.composer-shell .selected-model-chip:not(:disabled, [aria-expanded="true"]):hover`).get("background"))
      .toBe("var(--fill)");
    expect(declarationsFor(surfaceRules, `.composer-shell .selected-model-chip[aria-expanded="true"]`).get("background"))
      .toBe("var(--fill-strong)");
  });

  it("keeps an open chip on the strong fill while the pointer rests on it", () => {
    const { document } = chipWindow;
    document.body.innerHTML = [
      '<div class="composer-shell"><div class="composer-setting-family">',
      '<button type="button" class="composer-pill composer-setting-trigger composer-chip" aria-expanded="false"></button>',
      '<button type="button" class="composer-pill composer-setting-trigger composer-chip" aria-expanded="false" disabled></button>',
      '</div><div class="composer-checkout-context">',
      '<button type="button" class="composer-checkout-branch checkout-branch-button composer-chip" aria-expanded="false"></button>',
      "</div></div>",
    ].join("");
    const [chip, disabled, branch] = [...document.querySelectorAll("button")];
    const paint = (element: typeof chip, hover: boolean) => [
      cascadedValue(element!, ["background", "background-color"], hover),
      cascadedValue(element!, ["color"], hover),
    ];
    for (const control of [chip, branch]) {
      expect(paint(control, false)).toEqual(["transparent", "var(--text)"]);
      expect(paint(control, true)).toEqual(["var(--fill)", "var(--text)"]);
      control!.setAttribute("aria-expanded", "true");
      expect(paint(control, false)).toEqual(["var(--fill-strong)", "var(--text)"]);
      expect(paint(control, true)).toEqual(["var(--fill-strong)", "var(--text)"]);
    }
    expect(paint(disabled, true)).toEqual(["transparent", "var(--text-muted)"]);
  });

  it("lays the card out as two rows on the composer scale tokens, with the toolbar's chips on the text's left edge", () => {
    const zone = declarationsFor(surfaceRules, ".composer-shell .composer-input-zone");
    expect(zone.get("padding"))
      .toBe("var(--composer-zone-padding-top) var(--composer-zone-padding-inline) var(--composer-zone-padding-bottom)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer textarea").get("min-height")).toBe("var(--composer-input-min-height)");
    const toolbar = declarationsFor(surfaceRules, ".composer-shell .composer-toolbar");
    expect([toolbar.get("grid-template-areas"), toolbar.get("grid-template-rows"), toolbar.get("padding")]).toEqual([
      '"rail send"',
      "var(--composer-toolbar-height)",
      "0 calc(var(--composer-zone-padding-inline) - var(--composer-chip-inset)) var(--composer-toolbar-padding-bottom)",
    ]);
    expect(surface).not.toMatch(/composer-checkout-strip|composer-strip-inset|composer-rail-inset/u);
    const scales = new Map([
      [":root", ["16px", "20px", "8px", "44px", "40px", "12px", "28px"]],
      [':root[data-interface-scale="compact"]', ["14px", "18px", "6px", "40px", "38px", "10px", "26px"]],
      [':root[data-interface-scale="comfortable"]', ["17px", "21px", "9px", "46px", "42px", "13px", "30px"]],
      [':root[data-interface-scale="large"]', ["18px", "22px", "10px", "48px", "44px", "14px", "32px"]],
    ]);
    const tokens = [
      "--composer-zone-padding-top",
      "--composer-zone-padding-inline",
      "--composer-zone-padding-bottom",
      "--composer-input-min-height",
      "--composer-toolbar-height",
      "--composer-toolbar-padding-bottom",
      "--composer-icon-button-size",
    ];
    for (const [scale, values] of scales) {
      const declared = declarationsFor(rules, scale);
      expect(tokens.map((token) => declared.get(token)), scale).toEqual(values);
    }
    const narrow = "@container (max-width: 480px)";
    expect(declarationsFor(surfaceRules, ".composer-shell .composer", narrow).get("--composer-zone-padding-inline")).toBe("14px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-toolbar", narrow).get("--composer-chip-inset")).toBe("4px");
  });

  it("orders the right cluster ring, More, Attach and Send on 28px icon buttons 4px apart", () => {
    const icons = declarationsFor(surfaceRules, ".composer-shell :is(.composer-tools-toggle, .composer-more-trigger, .composer-attach-actions .icon-button)");
    expect([icons.get("width"), icons.get("height"), icons.get("color")])
      .toEqual(["var(--composer-icon-button-size)", "var(--composer-icon-button-size)", "var(--text-muted)"]);
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-primary-rail").get("gap")).toBe("4px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-toolbar").get("column-gap")).toBe("4px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-attach-actions").get("gap")).toBe("4px");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-actions").get("margin-left")).toBe("auto");
    const ring = declarationsFor(surfaceRules, ".composer-shell .composer-actions .usage-popover-trigger");
    expect([ring.get("width"), ring.get("height")]).toEqual([
      "max(var(--composer-icon-button-size), var(--usage-ring-size))",
      "max(var(--composer-icon-button-size), var(--usage-ring-size))",
    ]);
  });

  it("hides folded chips and any chip group left empty by folding", () => {
    expect(declarationsFor(surfaceRules, '.composer-shell [data-composer-fold][data-folded="true"]').get("display")).toBe("none");
    expect(declarationsFor(surfaceRules, '.composer-shell :is(.composer-setting-family, .composer-checkout-context):not(:has(> :not([data-folded="true"])))').get("display"))
      .toBe("none");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-options > *").get("flex")).toBe("0 0 auto");
    expect(declarationsFor(surfaceRules, '.composer-shell .composer-options[data-fold-exhausted="true"] > :is(.model-chooser-anchor, .composer-checkout-context)').get("flex-shrink"))
      .toBe("1");
  });
});

describe("composer send and stop", () => {
  const sendRules = parseCssRules(sendActions);
  const FORCED = "@media (forced-colors: active)";
  const READY = `${SEND}:not(:disabled, [aria-disabled="true"], [aria-busy="true"])`;
  const EMPTY = `${SEND}:is(:disabled, [aria-disabled="true"]):not([data-motion-state="sending"])`;
  const SENDING = `${SEND}[data-motion-state="sending"]`;
  const CROWN_STOP = `${SEND}:is(.stop-button, [data-motion-state="stop"])`;

  it("draws the send as an exactly 32px crown disc of field and optics layers over the send core with the white glyph", () => {
    const send = declarationsFor(sendRules, SEND);
    expect([send.get("width"), send.get("height"), send.get("min-width"), send.get("flex"), send.get("border-radius")])
      .toEqual(["32px", "32px", "32px", "0 0 32px", "50%"]);
    expect([send.get("background"), send.get("color"), send.get("isolation"), send.get("opacity")])
      .toEqual(["var(--send-core)", "var(--send-glyph)", "isolate", "1"]);
    expect(send.get("box-shadow")).toBe("-3px -1px 10px -3px var(--send-glow-a), 3px 3px 11px -3px var(--send-glow-b)");
    expect(send.get("transition")).toBe("transform 130ms cubic-bezier(.2,.7,.2,1)");
    expect(send.get("--send-field")).toMatch(/^radial-gradient\(circle 11px at 50% 48% in srgb, var\(--send-core\).*conic-gradient\(from 195deg in srgb, var\(--send-deep\)/u);
    expect(send.get("--send-optics")).toMatch(/^radial-gradient\(ellipse 2px \.65px at 30% 6% in srgb.*radial-gradient\(ellipse 12px 3px at 44% 20% in srgb, color-mix\(in srgb, var\(--send-glyph\) 6%, transparent\)/u);
    expect(declarationsFor(sendRules, `${SEND}::before`).get("background")).toBe("var(--send-field)");
    expect(declarationsFor(sendRules, `${SEND}::after`).get("background")).toMatch(/^var\(--send-optics\), radial-gradient\(circle 16px at 50% 50% in srgb, transparent 83%/u);
    const glyph = declarationsFor(sendRules, `${SEND} > .composer-send-motion-icon`);
    expect([glyph.get("width"), glyph.get("height"), glyph.get("z-index"), glyph.get("filter")])
      .toEqual(["16px", "16px", "2", "drop-shadow(0 .5px .4px rgb(0 0 0 / .35))"]);
    expect(surface).toContain("--composer-send-size: 32px;");
    expect(declarationsFor(surfaceRules, SEND).get("margin-left")).toBe("0");
    expect(styles).not.toMatch(/^\.(?:send|stop)-button/mu);
  });

  it("lifts the ready disc on hover while the cut turns 14deg and the optics counter-turn, and compresses it on press", () => {
    const send = declarationsFor(sendRules, SEND);
    expect([send.get("--send-turn"), send.get("--send-refraction")]).toEqual(["14deg", "rotate(-4deg)"]);
    expect(declarationsFor(sendRules, `${READY}:hover`).get("transform")).toBe("translateY(-1px)");
    expect(declarationsFor(sendRules, `${READY}:hover::before`).get("transform")).toBe("rotate(var(--send-turn))");
    expect(declarationsFor(sendRules, `${READY}:hover::after`).get("transform")).toBe("var(--send-refraction)");
    expect(declarationsFor(sendRules, `${READY}:active`).get("transform")).toBe("translateY(.5px) scale(.94)");
    expect(declarationsFor(sendRules, `${READY}:active::before`).get("transform")).toBe("rotate(8deg)");
    expect(declarationsFor(sendRules, `${READY}:active::after`).get("transform")).toBe("translateY(.6px) scale(.99)");
    const focus = declarationsFor(sendRules, `${SEND}:focus-visible`);
    expect([focus.get("outline"), focus.get("outline-offset")]).toEqual(["2px solid var(--focus-ring)", "3px"]);
    for (const rule of surfaceRules.filter(({ declarations }) => declarations.has("transform"))) {
      expect(rule.selectors.join(), "the surface leaves send motion to the crown").not.toContain(".send-button");
    }
  });

  it("keeps the empty send on quiet opaque glass with the muted arrow, then ignites the field over a safe disc", () => {
    const empty = declarationsFor(sendRules, EMPTY);
    expect([empty.get("background"), empty.get("color"), empty.get("opacity"), empty.get("transform")])
      .toEqual(["var(--send-empty)", "var(--send-empty-glyph)", "1", "none"]);
    const field = declarationsFor(sendRules, `${EMPTY}::before`);
    expect([field.get("opacity"), field.get("transition")]).toEqual(["0", "none"]);
    expect(declarationsFor(sendRules, `${EMPTY}::after`).get("opacity")).toBe("0");
    expect(declarationsFor(sendRules, `${SEND}::before`).get("transition")).toContain("opacity 260ms ease-out");
    expect(declarationsFor(sendRules, `${SEND}::after`).get("transition")).toContain("opacity 180ms ease-out");
    expect(surface).not.toMatch(/send-button\[aria-disabled="true"\]\s*\{/u);
  });

  it("sweeps a conic light through the sending disc while the loader glyph stays still, and pauses it while hidden", () => {
    const sending = declarationsFor(sendRules, SENDING);
    expect([sending.get("background"), sending.get("color"), sending.get("cursor")]).toEqual(["var(--send-core)", "var(--send-glyph)", "progress"]);
    const sweep = declarationsFor(sendRules, `${SENDING}::before`);
    expect(sweep.get("background")).toMatch(/^conic-gradient\(from 0deg in srgb, var\(--send-deep\) 0deg 130deg/u);
    expect(sweep.get("animation")).toBe("send-momentum 1600ms linear infinite");
    expect(declarationsFor(sendRules, `${SENDING} .composer-send-motion-icon`).get("animation")).toBe("none");
    expect(sendActions).toContain("@keyframes send-momentum { to { transform: rotate(360deg); } }");
    expect(declarationsFor(sendRules, `.app-shell[data-document-visible="false"] ${SEND}::before`).get("animation-play-state")).toBe("paused");
  });

  it("draws Stop as a neutral recessed disc with a structural edge, never the coloured send field", () => {
    for (const selector of [CROWN_STOP, `${CROWN_STOP}:is(:disabled, :hover, :active)`]) {
      const stop = declarationsFor(sendRules, selector);
      expect([stop.get("background"), stop.get("color"), stop.get("border"), stop.get("opacity")], selector)
        .toEqual(["var(--send-stop)", "var(--send-stop-glyph)", "1px solid var(--send-stop-line)", "1"]);
    }
    expect(declarationsFor(sendRules, `${CROWN_STOP}::before`).get("display")).toBe("none");
    expect(declarationsFor(sendRules, `${CROWN_STOP}::after`).get("display")).toBe("none");
    expect(surface, "Stop keeps the outlined square").not.toMatch(/composer-send-motion-icon path\s*\{[^}]*fill:/u);
    expect(all).not.toContain("--danger-fill");
  });

  it("paints the eager composer stylesheet's send fallback with the crown's solid core, empty and stop colours", () => {
    const fallback = ".composer-shell .composer-input-actions :where(.send-button)";
    expect([...declarationsFor(surfaceRules, fallback)]).toEqual([
      ["border", "1px solid transparent"], ["color", "var(--send-glyph)"], ["background", "var(--send-core)"],
    ]);
    expect(declarationsFor(surfaceRules, `.composer-shell .composer-input-actions :where(.send-button:is(:disabled, [aria-disabled="true"]))`).get("background"))
      .toBe("var(--send-empty)");
    expect(declarationsFor(surfaceRules, ".composer-shell .composer-input-actions :where(.send-button.stop-button)").get("background"))
      .toBe("var(--send-stop)");
    expect(styles).toContain("--send-core:");
  });

  it("keeps the labelled send a pill without the field turn and folds it into the round disc in a narrow composer", () => {
    expect(declarationsFor(sendRules, `${SEND}.has-label::before`).get("transform")).toBe("none !important");
    expect(declarationsFor(sendRules, `${SEND}.has-label::after`).get("background")).toBe("var(--send-optics)");
    const pill = declarationsFor(sendRules, `${SEND}.has-label`);
    expect([pill.get("width"), pill.get("border-radius")]).toEqual(["auto", "999px"]);
    const disc = declarationsFor(sendRules, `${SEND}.has-label`, NARROW_SEND);
    expect([disc.get("width"), disc.get("border-radius")]).toEqual(["var(--composer-send-size)", "50%"]);
  });

  it("stills every send transform, transition and animation for reduced motion", () => {
    for (const selector of [SEND, `${SEND}::before`, `${SEND}::after`, `${SEND} .composer-send-motion-icon`]) {
      const reduced = declarationsFor(sendRules, selector, REDUCED);
      expect([reduced.get("transition"), reduced.get("animation"), reduced.get("transform")], selector)
        .toEqual(["none !important", "none !important", "none !important"]);
    }
    for (const rule of surfaceRules.filter(({ context, declarations }) => context === "" && declarations.has("transition"))) {
      for (const selector of rule.selectors) {
        expect(declarationsFor(surfaceRules, selector, REDUCED).get("transition"), selector).toBe("none");
      }
    }
  });

  it("returns every send state to system button colours and drops the optical layers in forced colours", () => {
    const forced = declarationsFor(sendRules, `${SEND}:is(:disabled, :hover, :active, [aria-disabled="true"], [data-motion-state="sending"], .stop-button, [data-motion-state="stop"])`, FORCED);
    expect([forced.get("forced-color-adjust"), forced.get("background"), forced.get("color"), forced.get("border"), forced.get("box-shadow")])
      .toEqual(["auto", "ButtonFace !important", "ButtonText !important", "1px solid ButtonText !important", "none !important"]);
    expect(declarationsFor(sendRules, SEND, FORCED).get("background")).toBe("ButtonFace !important");
    const empty = declarationsFor(sendRules, EMPTY, FORCED);
    expect([empty.get("color"), empty.get("border-color")]).toEqual(["GrayText !important", "GrayText !important"]);
    expect(declarationsFor(sendRules, `${SEND}::before`, FORCED).get("display")).toBe("none !important");
    expect(declarationsFor(sendRules, `${SEND}::after`, FORCED).get("display")).toBe("none !important");
    expect(declarationsFor(sendRules, `${SEND}:focus-visible`, FORCED).get("outline-color")).toBe("Highlight");
  });
});
