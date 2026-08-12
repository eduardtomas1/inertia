import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/main/system-boot-id", () => ({
  readSystemBootId: () => "test:00000000-0000-4000-8000-000000000001",
}));

import { prepareRuntimeBootstrapSafety } from "../../src/main/runtime-bootstrap-safety";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime bootstrap safety", () => {
  it("creates a fresh profile data directory before opening its journals", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "fresh", "runtime");
    directories.push(root);
    expect(existsSync(dataDirectory)).toBe(false);

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: false,
    });
    expect(lstatSync(dataDirectory).isDirectory()).toBe(true);
  });
});
