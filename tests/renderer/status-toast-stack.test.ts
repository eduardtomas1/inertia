import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const read = (path: string) => readSourceText(new URL(`../../src/renderer/src/${path}`, import.meta.url));

describe("status toast stack placement", () => {
  it("mounts the stack inside the workspace frame", () => {
    const layout = read("components/AppLayout.tsx");
    const frame = layout.slice(layout.indexOf('className={`workspace-frame'), layout.indexOf("</section>"));
    expect(frame).toContain("<StatusToastStack");
  });

  it("places the stack at the top right of the chat area, under the header and clear of the composer", () => {
    const css = read("styles.css");
    expect(css).toMatch(/\.workspace-frame > \.status-overlay-stack \{\n  position: absolute;\n  top: calc\(48px \+ 12px\);\n  right: 12px;\n  z-index: 100;\n  display: flex;\n  width: min\(440px, calc\(100% - 24px\)\);/u);
    expect(css).toMatch(/\.workspace-frame\.has-right-panel > \.status-overlay-stack \{\n  right: calc\(var\(--workspace-tools-width\) \+ 12px\);\n  width: min\(440px, calc\(100% - var\(--workspace-tools-width\) - 24px\)\);\n\}/u);
    expect(css).not.toMatch(/\.status-overlay-stack \{[^}]*bottom:/u);
  });

  it("docks below split pane headers so a toast never covers a pane's title or actions", () => {
    const css = read("styles.css");
    expect(css).toMatch(/\.workspace-frame:has\(\.conversation-split-header\) > \.status-overlay-stack \{\n  top: calc\(48px \+ 33px \+ 12px\);\n\}/u);
    expect(css).toMatch(/\.conversation-split-header \{[^}]*min-height: 32px;[^}]*border-bottom: 1px solid/u);
  });

  it("keeps the stack left of the panel sheet, sized from the sheet's own width at every breakpoint", () => {
    const css = read("styles.css");
    expect(css).toMatch(/\.workspace-frame\.has-right-sheet > \.status-overlay-stack \{\n  --workspace-sheet-width: min\(448px, max\(320px, 42vw\), calc\(100% - 24px\)\);\n  right: calc\(var\(--workspace-sheet-width\) \+ 12px\);\n  width: max\(240px, min\(440px, calc\(100% - var\(--workspace-sheet-width\) - 24px\)\)\);\n\}/u);
    expect(css).toMatch(/\.workspace-body > \.workspace-panel\.is-sheet \{\n    width: min\(384px, 88%\);\n    min-width: 0;\n  \}\n\n  \.workspace-frame\.has-right-sheet > \.status-overlay-stack \{\n    --workspace-sheet-width: min\(384px, 88%\);\n  \}/u);
    expect(css).toMatch(/\.workspace-body > \.workspace-panel\.is-sheet \{\n  width: min\(448px, max\(320px, 42vw\)\);\n  max-width: calc\(100% - 24px\);/u);
  });
});
