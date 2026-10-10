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
});
