import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  waitForPackageSmokeResult,
  waitForRequestedPackageSmokeResults,
} from "../../src/main/package-smoke-results";
import {
  writePackagedSmokeResult,
} from "../../src/server/runtime/attachments/package-smoke-pdf";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function resultPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-smoke-results-"));
  directories.push(directory);
  return join(directory, name);
}

describe("package smoke result receipts", () => {
  it("accepts the image receipt independently from the PDF schema", async () => {
    const path = await resultPath("image.json");
    await writeFile(path, JSON.stringify({ ok: true }));
    await expect(waitForPackageSmokeResult(path, "image")).resolves.toBeUndefined();
  });

  it("rejects a malformed image receipt", async () => {
    const path = await resultPath("image.json");
    await writeFile(path, JSON.stringify({ ok: true, content: "wrong schema" }));
    await expect(waitForPackageSmokeResult(path, "image")).rejects.toThrow(
      "image smoke receipt is invalid",
    );
  });

  it("waits for every requested receipt before settling", async () => {
    const pdf = await resultPath("pdf.json");
    const image = join(pdf, "..", "image.json");
    const settled = vi.fn();
    const waiting = waitForRequestedPackageSmokeResults(
      { pdf, image },
      { timeoutMs: 1_000, pollIntervalMs: 2 },
    ).then(settled);
    await writePackagedSmokeResult(pdf, { ok: true, content: "PDF text" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).not.toHaveBeenCalled();
    await writePackagedSmokeResult(image, { ok: true });
    await waiting;
    expect(settled).toHaveBeenCalledOnce();
  });
});
