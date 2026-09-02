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
    vi.useFakeTimers();
    try {
      const pdf = await resultPath("pdf.json");
      const image = join(pdf, "..", "image.json");
      let settled = false;
      const waiting = waitForRequestedPackageSmokeResults(
        { pdf, image },
        { timeoutMs: 1_000, pollIntervalMs: 2 },
      ).then(
        () => {
          settled = true;
          return { status: "fulfilled" as const };
        },
        (error: unknown) => {
          settled = true;
          return { status: "rejected" as const, error };
        },
      );
      await writePackagedSmokeResult(pdf, { ok: true, content: "PDF text" });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      await writePackagedSmokeResult(image, { ok: true });
      await vi.advanceTimersByTimeAsync(2);
      await expect(waiting).resolves.toEqual({ status: "fulfilled" });
    } finally {
      vi.useRealTimers();
    }
  });
});
