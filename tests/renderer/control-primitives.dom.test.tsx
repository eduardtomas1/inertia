import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IconButton } from "../../src/renderer/src/components/ui";

const css = readFileSync("src/renderer/src/styles.css", "utf8")
  .replace(/\r\n?/gu, "\n");

let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement("style");
  sheet.textContent = css.replace(/^@import[^;]*;/mu, "");
  document.head.append(sheet);
});

afterAll(() => {
  sheet.remove();
});

function controls(): HTMLButtonElement[] {
  render(
    <div>
      <button type="button" className="primary-button">Save</button>
      <button type="button" className="secondary-button">Cancel</button>
      <button type="button" className="subtle-button">Retry</button>
      <IconButton label="Refresh">R</IconButton>
    </div>,
  );
  return ["Save", "Cancel", "Retry", "Refresh"].map((name) => screen.getByRole("button", { name }));
}

describe("button primitives", () => {
  it("gives every button variant one height, radius, size and weight", () => {
    for (const button of controls()) {
      const style = getComputedStyle(button);
      expect(style.borderRadius, button.className).toBe("6px");
      expect(style.transform, button.className).not.toMatch(/translate/u);
      if (button.classList.contains("icon-button")) {
        expect(style.width).toBe("32px");
        expect(style.height).toBe("32px");
      } else {
        expect(style.minHeight, button.className).toBe("32px");
        expect(style.fontSize, button.className).toBe("13px");
        expect(style.fontWeight, button.className).toBe("500");
      }
    }
  });

  it("paints the primary with the accent and the secondary as a bordered ghost", () => {
    const [primary, secondary, subtle, icon] = controls();
    expect(getComputedStyle(primary!).backgroundColor).toBe(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(getComputedStyle(secondary!).borderTopWidth).toBe("1px");
    for (const ghost of [secondary!, subtle!, icon!]) {
      expect(getComputedStyle(ghost).backgroundColor, ghost.className).toBe("transparent");
      expect(getComputedStyle(ghost).boxShadow, ghost.className).toMatch(/^(?:none)?$/u);
    }
  });

  it("dims native and ARIA disabled buttons with one opacity and a default cursor", () => {
    const [primary, secondary, , icon] = controls();
    primary!.disabled = true;
    secondary!.setAttribute("aria-disabled", "true");
    icon!.disabled = true;
    for (const button of [primary!, secondary!, icon!]) {
      const style = getComputedStyle(button);
      expect(style.opacity, button.className).toBe("0.68");
      expect(style.cursor, button.className).toBe("default");
    }
  });

  it("keeps hover and press feedback off disabled buttons and never lifts", () => {
    expect(css).toMatch(/:is\(\.secondary-button, \.subtle-button, \.text-button, \.icon-button\):hover:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--fill\);/u);
    expect(css).toMatch(/:is\(\.secondary-button, \.subtle-button, \.text-button, \.icon-button\):active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--fill-strong\);/u);
    expect(css).toMatch(/:is\(\.subtle-button, \.text-button, \.icon-button\):active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*transform: scale\(0\.97\);/u);
    expect(css).toMatch(/\.primary-button:is\(:hover, :active\):not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--accent-hover\);/u);
    expect(css).not.toMatch(/translateY\(-1px\)/u);
  });
});

describe("focus ring", () => {
  const rendererCss = [
    "styles.css",
    "components/BeautifulUiMotion.css",
    "components/settings/settings.css",
    "components/UsageView.css",
    "components/UsageLimitsPanel.css",
    "components/ThemeLibrary.css",
  ].map((path) => readFileSync(`src/renderer/src/${path}`, "utf8")).join("\n");

  it("draws one accent ring, outset on controls and inset on rows, tabs and menu items", () => {
    expect(css).toMatch(/^:focus-visible \{\n  outline: 2px solid var\(--focus-ring\);\n  outline-offset: 2px;\n\}/mu);
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    for (const row of ['[role="menuitem"]', '[role="option"]', '[role="tab"]', ".file-entry", ".workspace-repository-file"]) {
      expect(inset).toContain(row);
    }
  });

  it("leaves no per-component restatement of the ring or its offset", () => {
    const outside = rendererCss.replace(/@media \(forced-colors: active\)[\s\S]*?\n\}\n/gu, "");
    const restated = [...outside.matchAll(/[^{}]*:focus-visible[^{}]*\{[^}]*outline: 2px solid var\(--(?:accent|text)\)/gu)];
    expect(restated.map((match) => match[0].trim())).toEqual([]);
    const offsets = [...outside.matchAll(/outline-offset:\s*(-?\d+)px/gu)].map((match) => match[1]);
    expect(new Set(offsets)).toEqual(new Set(["2", "-2"]));
  });
});

describe("field primitives", () => {
  const composerCss = readFileSync("src/renderer/src/components/composer/ComposerSurface.css", "utf8");

  it("moves a bordered field from the line to the accent on focus with no glow or ring", () => {
    const fields = /^:is\(\n(?<fields>[\s\S]*?)\n\):focus,\n:is\(\n(?<wraps>[\s\S]*?)\n\):focus-within \{\n(?<body>[\s\S]*?)\n\}/mu.exec(css)?.groups;
    expect(fields?.body).toBe("  outline: none;\n  border-color: var(--accent);\n  box-shadow: none;");
    for (const field of [".setting-input", ".setting-select", ".commit-dialog > label input", ".multi-spawn-prompt-zone textarea"]) {
      expect(fields?.fields).toContain(field);
    }
    expect(fields?.wraps).toContain(".preview-address-form");
    expect(css).not.toMatch(/--shadow-focus|--focus-ring-soft/u);
    expect(css).toMatch(/^::placeholder \{\n  color: var\(--text-muted\);/mu);
  });

  it("keeps the composer flat and only strengthens its border on focus", () => {
    expect(composerCss).toMatch(/\.composer-shell \.composer:focus-within > \.composer-surface \{\n  border-color: var\(--line\);\n\}/u);
    expect(composerCss).toMatch(/\.composer-shell \.composer > \.composer-surface \{[^}]*background: var\(--surface-raised\);[^}]*box-shadow: var\(--shadow-float\);/u);
    expect(`${css}\n${composerCss}`).not.toMatch(/^\.composer(?:-shell \.composer)?:focus-within[^{,]*\{[^}]*(?:--focus-ring|--accent|gradient|box-shadow:(?! none))/mu);
    expect(composerCss).toMatch(/\.composer-shell \.composer textarea \{[^}]*max-height: 200px;/u);
  });
});
