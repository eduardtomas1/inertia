// @inertia-test-suite portable
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sameCheckoutPath } from "../../src/server/cli-import/resume-cwd";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-same-checkout-"));
  roots.push(directory);
  return directory;
}

describe("sameCheckoutPath", () => {
  it("matches one folder through a symlink and tells two folders apart", () => {
    const base = root();
    const checkout = join(base, "Checkout");
    const other = join(base, "other");
    mkdirSync(checkout);
    mkdirSync(other);
    const link = join(base, "link");
    symlinkSync(checkout, link, process.platform === "win32" ? "junction" : "dir");
    expect(sameCheckoutPath(checkout, checkout)).toBe(true);
    expect(sameCheckoutPath(link, checkout)).toBe(true);
    expect(sameCheckoutPath(checkout, link)).toBe(true);
    expect(sameCheckoutPath(other, checkout)).toBe(false);
  });

  it("matches nothing for a missing folder", () => {
    const base = root();
    const checkout = join(base, "checkout");
    mkdirSync(checkout);
    expect(sameCheckoutPath(join(base, "gone"), checkout)).toBe(false);
    expect(sameCheckoutPath(checkout, join(base, "gone"))).toBe(false);
  });

  it("treats a different letter case as the same folder where the file system ignores case", () => {
    const base = root();
    const checkout = join(base, "Checkout");
    mkdirSync(checkout);
    const otherCase = join(base, "checkout");
    // Only meaningful on a case-insensitive volume, such as the macOS and Windows defaults.
    if (!existsSync(otherCase)) return;
    expect(sameCheckoutPath(otherCase, checkout)).toBe(true);
  });
});
