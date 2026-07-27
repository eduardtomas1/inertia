import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
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
    const familyStart = composerSource.indexOf(
      'className="composer-setting-family"',
    );
    const moreStart = composerSource.indexOf(
      'className="popover-anchor composer-more-control"',
      familyStart,
    );
    const family = composerSource.slice(familyStart, moreStart);

    expect(familyStart).toBeGreaterThan(-1);
    expect(moreStart).toBeGreaterThan(familyStart);
    expect(family).toContain('role="group"');
    expect(family).toContain('aria-label="Composer settings"');
    expect(family).toContain('data-composer-setting="reasoning"');
    expect(family).toContain('data-composer-setting="access"');
    expect(family).toContain('data-composer-setting="mode"');
    expect(family).toContain('className="composer-setting-value"');
    expect(family).toContain('className="composer-setting-icon" size={13}');
    expect(family).toContain('className="composer-setting-chevron" size={11}');
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
      expect(composerSource).toContain(
        `id={menuId("${menu}")}`,
      );
      expect(composerSource).toContain(
        `setMenuPopover("${menu}", node)`,
      );
    }
    expect(composerSource.match(/composer-setting-popover/gu)).toHaveLength(3);
    expect(composerSource).toContain('<div className="popover-title">Reasoning</div>');
    expect(composerSource).toContain('<div className="popover-title">Project access</div>');
    expect(composerSource).toContain('<div className="popover-title">Mode</div>');
    expect(composerSource.match(/role="menuitemradio"/gu)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(composerSource).toContain("selectedModel.reasoningOptions.map");
    expect(composerSource).toContain("accessOptions.map");
    expect(composerSource).toContain('(["build", "plan"] as InteractionMode[])');
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
    expect(composerSource).toContain('aria-label="More composer options"');
    expect(composerSource).toContain('aria-haspopup="menu"');
    expect(composerSource).toContain('aria-controls={menuId("more")}');
  });

  it("supports keyboard entry, menu navigation, outside dismissal, and focus restoration", () => {
    expect(composerSource).toContain(
      'if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return',
    );
    expect(composerSource).toContain(
      "focusComposerMenuEdge(menuName",
    );
    expect(composerSource).toContain(
      '["ArrowDown", "ArrowUp", "Home", "End"]',
    );
    expect(composerSource).toContain(
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
