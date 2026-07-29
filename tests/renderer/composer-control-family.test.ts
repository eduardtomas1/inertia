import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerSettings.tsx", import.meta.url),
  "utf8",
);
const moreMenuSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerMoreMenu.tsx", import.meta.url),
  "utf8",
);
const menuHookSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/useComposerMenus.ts", import.meta.url),
  "utf8",
);
const dismissibleMenuSource = readFileSync(
  new URL("../../src/renderer/src/hooks/useDismissibleMenu.ts", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("composer setting control family", () => {
  it("groups reasoning, access, and mode as compact value triggers", () => {
    const familyStart = settingsSource.indexOf(
      'className="composer-setting-family"',
    );
    const family = settingsSource.slice(familyStart);

    expect(familyStart).toBeGreaterThan(-1);
    expect(family).toContain('role="group"');
    expect(family).toContain('aria-label="Composer settings"');
    expect(family).toContain('data-composer-setting="reasoning"');
    expect(family).toContain('data-composer-setting="access"');
    expect(family).toContain('data-composer-setting="mode"');
    expect(family).toContain('className="composer-setting-value"');
    expect(family.match(/className="composer-setting-icon"/gu)).toHaveLength(3);
    expect(family.match(/className="composer-setting-chevron"/gu)).toHaveLength(3);
    expect(family.match(/size=\{13\}/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(family.match(/size=\{11\}/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(family).toContain("Current level:");
    expect(family).toContain("Current access:");
    expect(family).toContain("Current mode:");
    for (const setting of ["reasoning", "access", "mode"]) {
      const triggerStart = family.indexOf(
        `data-composer-setting="${setting}"`,
      );
      const triggerEnd = family.indexOf("</button>", triggerStart);
      const trigger = family.slice(triggerStart, triggerEnd);
      expect(trigger).not.toContain("<small>");
      expect(trigger).not.toContain("description");
    }
  });

  it("keeps option detail inside three consistent radio menus", () => {
    for (const menu of ["reasoning", "access", "mode"]) {
      expect(settingsSource).toContain(
        `id={menuId("${menu}")}`,
      );
      expect(settingsSource).toContain(
        `setMenuPopover("${menu}", node)`,
      );
    }
    expect(settingsSource.match(/composer-setting-popover/gu)).toHaveLength(3);
    expect(settingsSource).toContain('<div className="popover-title">Reasoning</div>');
    expect(settingsSource).toContain('<div className="popover-title">Project access</div>');
    expect(settingsSource).toContain('<div className="popover-title">Mode</div>');
    expect(settingsSource.match(/role="menuitemradio"/gu)).toHaveLength(3);
    expect(settingsSource).toContain("selectedModel.reasoningOptions.map");
    expect(settingsSource).toContain("accessOptions.map");
    expect(settingsSource).toContain('(["build", "plan"] as InteractionMode[])');
  });

  it("uses shared semantic states, geometry, icon scale, and restrained separators", () => {
    for (const token of [
      "--composer-setting-separator",
      "--composer-setting-hover",
      "--composer-setting-open",
      "--composer-setting-focus",
    ]) {
      expect(css).toContain(`${token}:`);
    }
    expect(css).toMatch(
      /\.composer-setting-family\s*\{[^}]*display:\s*flex;[^}]*gap:\s*1px;[^}]*border-right:\s*1px solid var\(--composer-setting-separator\);[^}]*border-left:\s*1px solid var\(--composer-setting-separator\)/su,
    );
    expect(css).toMatch(
      /\.composer-pill\s*\{[^}]*height:\s*var\(--composer-control-height\);[^}]*border:\s*0;[^}]*font-size:\s*max\(calc\(var\(--ui-font-secondary\) \+ var\(--platform-readability-adjustment\)\), 10px\)/su,
    );
    expect(css).toMatch(
      /\.composer-setting-trigger\s*\{[^}]*max-width:\s*148px;[^}]*gap:\s*4px;[^}]*padding:\s*0 7px/su,
    );
    expect(css).toMatch(
      /\.composer-pill:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--composer-setting-hover\)/su,
    );
    expect(css).toMatch(
      /\.composer-pill\.is-active,[\s\S]*?\.composer-pill\[aria-expanded="true"\]\s*\{[^}]*background:\s*var\(--composer-setting-open\)/su,
    );
    expect(css).toMatch(
      /\.composer-pill:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--composer-setting-focus\);[^}]*outline-offset:\s*1px/su,
    );
    expect(css).toMatch(
      /\.composer-setting-popover,[\s\S]*?\.composer-mode-popover\s*\{[^}]*width:\s*min\(260px, calc\(100vw - 32px\)\);[^}]*padding:\s*6px/su,
    );
    expect(css).toMatch(
      /\.composer-setting-popover button\[aria-checked="true"\]\s*\{[^}]*background:\s*color-mix/su,
    );
    expect(css).toMatch(
      /\.composer-options\s*\{[^}]*position:\s*relative;[^}]*flex:\s*0 1 auto/su,
    );
    expect(css).toMatch(
      /\.composer-skills-popover\s*\{[^}]*right:\s*auto;[^}]*left:\s*8px;[^}]*width:\s*min\([^}]*calc\(100% - 16px\)[^}]*calc\(100cqw - 16px\)[^}]*max-width:\s*min\([^}]*calc\(100% - 16px\)[^}]*calc\(100cqw - 16px\)/su,
    );
    expect(css).toMatch(
      /\.composer-skills-control\s*\{[^}]*position:\s*static/su,
    );
    expect(css).toMatch(
      /\.composer-more-layer\s*\{[^}]*right:\s*0/su,
    );
    expect(css).toMatch(
      /@container \(max-width:\s*720px\)[\s\S]*?\.composer-options > \.composer-more-control\s*\{[^}]*display:\s*block;[^}]*position:\s*static/su,
    );
  });

  it("moves the whole low-priority family into one More control at the container threshold", () => {
    const compactRule = css.match(
      /@container \(max-width:\s*720px\)\s*\{(?<body>[\s\S]*?)\n\}/u,
    )?.groups?.body ?? "";

    expect(compactRule).toContain(".composer-setting-family");
    expect(compactRule).toContain("display: none");
    expect(compactRule).toContain(".composer-more-control");
    expect(compactRule).toContain("display: block");
    expect(compactRule).not.toContain(".model-chooser-anchor {\n    display: none");
    expect(compactRule).not.toContain(".composer-usage {\n    display: none");
    expect(compactRule).not.toContain(".send-button {\n    display: none");
    expect(moreMenuSource).toContain('aria-label="More composer options"');
    expect(moreMenuSource).toContain('aria-haspopup="menu"');
    expect(moreMenuSource).toContain('aria-controls={menuId("more")}');
  });

  it("supports keyboard entry, menu navigation, outside dismissal, and focus restoration", () => {
    expect(menuHookSource).toContain(
      'if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return',
    );
    expect(menuHookSource).toContain(
      "focusComposerMenuEdge(",
    );
    expect(menuHookSource).toContain("menuName,");
    expect(menuHookSource).toContain(
      '["ArrowDown", "ArrowUp", "Home", "End"]',
    );
    expect(moreMenuSource).toContain(
      "openMoreSection(item.section, true)",
    );
    expect(dismissibleMenuSource).toContain(
      'dispatch({ type: "outside-pointer" })',
    );
    expect(dismissibleMenuSource).toContain(
      "outsidePointerShouldRestoreFocus(target)",
    );
    expect(dismissibleMenuSource).toContain(
      "if (outsidePointerShouldRestoreFocus(target)) restoreTriggerFocus(menu)",
    );
    expect(dismissibleMenuSource).toContain(
      'if (reason === "escape" || reason === "selection") restoreTriggerFocus(activeMenu)',
    );
  });
});
