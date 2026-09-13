import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const docs = join(root, "docs", "user");

describe("user docs", () => {
  it("only links to pages and files that exist", () => {
    const pages = readdirSync(docs).filter((name) => name.endsWith(".md"));
    expect(pages).toContain("README.md");
    for (const page of pages) {
      const text = readFileSync(join(docs, page), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
        if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
        const path = target.split("#")[0]!;
        expect(existsSync(resolve(docs, path)), `${page} links to ${target}`).toBe(true);
      }
    }
  });

  it("is reachable from the project README", () => {
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("docs/user/README.md");
  });
});
