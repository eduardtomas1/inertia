import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../src/renderer/src/${path}`, import.meta.url), "utf8");
const css = read("styles.css");
const detachedCss = read("detached-chat.css");

describe("Windows title bar overlay clearance", () => {
  it("marks the document with its platform so portalled surfaces can clear the caption buttons", () => {
    expect(read("main.tsx")).toMatch(/document\.documentElement\.dataset\.platform = window\.inertia\.getPlatform\(\);/u);
  });

  it("measures the overlay inset from the window controls overlay geometry", () => {
    expect(css).toMatch(/\.app-shell\.platform-win32 \{[^}]*--titlebar-overlay-inset: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/u);
    expect(detachedCss).toMatch(/\.detached-chat-shell\.platform-win32 \{\n  --titlebar-overlay-inset: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/u);
  });

  it("pads the header, panel tabs, corner controls and detached header by the overlay inset", () => {
    expect(css).toMatch(/\.platform-win32 \.workspace-frame:not\(\.has-right-panel\) > \.workspace-header \{\n  padding-right: calc\(14px \+ var\(--workspace-corner-controls-width, 0px\) \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(css).toMatch(/\.platform-win32 \.workspace-panel:not\(\.is-stacked\) > \.workspace-panel-tabs \{\n  padding-right: calc\(var\(--workspace-corner-controls-width, 0px\) \+ 16px \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(css).toMatch(/\.platform-win32 \.workspace-corner-controls \{\n  right: calc\(12px \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(detachedCss).toMatch(/\.detached-chat-shell\.platform-win32 \.detached-chat-header \{\n  padding-right: calc\(8px \+ var\(--titlebar-overlay-inset\)\);/u);
  });

  it("keeps the recovery notice and every dialog below the caption buttons", () => {
    expect(css).toMatch(/:root\[data-platform="win32"\] \.database-recovery-notice \{\n  top: calc\(env\(titlebar-area-height, 48px\) \+ 8px\);/u);
    expect(css).toMatch(/:root\[data-platform="win32"\] :is\(\.dialog-backdrop, \.multi-spawn-backdrop, \.daily-work-backdrop, \.attachment-preview-backdrop, \.snapshot-backdrop\) \{\n  padding-top: calc\(env\(titlebar-area-height, 48px\) \+ 8px\);/u);
    expect(css).toMatch(/:root\[data-platform="win32"\] :is\(\.dialog-backdrop, \.attachment-preview-backdrop\) \{\n  grid-template-rows: minmax\(0, 1fr\);\n\}\n\n:root\[data-platform="win32"\] :is\(\.dialog-backdrop, \.attachment-preview-backdrop\) > \* \{\n  max-height: 100%;\n\}/u);
  });
});
