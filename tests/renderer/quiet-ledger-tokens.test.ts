import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("Minimal Workstream tokens", () => {
  it("defines control target sizes and scales the model row from them", () => {
    const root = css.match(/:root\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";

    for (const token of [
      "--control-height",
      "--control-height-small",
      "--composer-control-height",
      "--model-row-height",
    ]) {
      expect(root, `missing ${token}`).toContain(`${token}:`);
    }
    expect(css).toMatch(
      /--model-row-height:\s*calc\(var\(--ui-control-height\)\s*\+\s*6px\)/u,
    );
  });
});
