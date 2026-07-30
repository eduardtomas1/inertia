import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/main/index.ts", import.meta.url),
  "utf8",
);

describe("main-process startup concurrency", () => {
  it("observes the window promise together with private-storage setup", () => {
    expect(source).toMatch(
      /await Promise\.all\(\[\s*createWindow\(\),\s*mkdir\(dataDirectory/u,
    );
    expect(source).not.toContain("const windowReady = createWindow()");
  });
});
