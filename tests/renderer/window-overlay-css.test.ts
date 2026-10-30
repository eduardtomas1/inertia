import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const read = (path: string) => readSourceText(new URL(`../../src/renderer/src/${path}`, import.meta.url));
const css = read("styles.css");
const detachedCss = read("detached-chat.css");

describe("Windows and Linux title bar overlay clearance", () => {
  it("marks the document with its platform so portalled surfaces can clear the caption buttons", () => {
    expect(read("main.tsx")).toMatch(/document\.documentElement\.dataset\.platform = window\.inertia\.getPlatform\(\);/u);
  });

  it("measures the overlay inset from the window controls overlay geometry", () => {
    expect(css).not.toContain("@property --titlebar-overlay-inset");
    expect(css).toMatch(/\.app-shell:is\(\.platform-win32, \.platform-linux\) \{[^}]*--titlebar-overlay-inset: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/u);
    expect(detachedCss).toMatch(/\.detached-chat-shell:is\(\.platform-win32, \.platform-linux\) \{\n  --titlebar-overlay-inset: max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/u);
  });

  it("pads the header, panel tabs and corner controls of both windows by the overlay inset", () => {
    expect(css).toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-frame:not\(\.has-right-panel\) > \.workspace-header \{\n  padding-right: calc\(14px \+ var\(--workspace-corner-controls-width, 0px\) \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(css).toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-panel:not\(\.is-stacked\) > \.workspace-panel-tabs \{\n  padding-right: calc\(var\(--workspace-corner-controls-width, 0px\) \+ 16px \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(css).toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-corner-controls \{\n  right: calc\(12px \+ var\(--titlebar-overlay-inset\)\);/u);
    expect(detachedCss).not.toContain(".detached-chat-header");
    expect(detachedCss).not.toMatch(/:is\(\.platform-win32, \.platform-linux\) [^{]*\.workspace-header \{/u);
  });

  it("keeps the right panel at 300px on Windows and Linux and clears the caption buttons only in its tab strip", () => {
    expect(css).not.toContain("--workspace-panel-width");
    expect(css).not.toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-body > \.workspace-panel\.is-(?:inline|sheet) \{/u);
    expect(css).not.toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-body\.has-tools \{/u);
    expect(css).not.toMatch(/:is\(\.platform-win32, \.platform-linux\) \.workspace-frame\.has-right-panel > \.workspace-header \{/u);
    expect(readSourceText(new URL("../../src/renderer/src/hooks/useWorkspaceLayout.ts", import.meta.url))).toContain("export const TOOLS_MIN_WIDTH = 300;");
  });

  it("keeps the recovery notice in the toast stack and every dialog below the caption buttons", () => {
    expect(css).not.toContain(":root[data-platform=\"win32\"] .database-recovery-notice");
    expect(css).not.toMatch(/\.database-recovery-notice \{[^}]*position: fixed/u);
    expect(css).toMatch(/:root:is\(\[data-platform="win32"\], \[data-platform="linux"\]\) \.dialog-backdrop \{\n  padding-top: calc\(env\(titlebar-area-height, 48px\) \+ 8px\);\n  grid-template-rows: minmax\(0, 1fr\);\n\}\n\n:root:is\(\[data-platform="win32"\], \[data-platform="linux"\]\) \.dialog-backdrop > \* \{\n  max-height: 100%;\n\}/u);
  });
});
