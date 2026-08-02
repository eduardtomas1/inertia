import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { writePackagedPdfSmokeResult } from "../../src/server/runtime/attachments/package-smoke-pdf";

it("publishes a complete packaged PDF receipt only after durable close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inertia-package-smoke-result-"));
  const resultPath = join(directory, "pdf-result.json");
  let releaseWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeStarted = false;
  const delayedOpen = (async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== "writeFile") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...writeArguments: Parameters<typeof target.writeFile>) => {
          writeStarted = true;
          await writeBlocked;
          await target.writeFile(...writeArguments);
        };
      },
    });
  }) as typeof open;
  try {
    const writing = writePackagedPdfSmokeResult(
      resultPath,
      { ok: true, content: "Packaged PDF extraction works" },
      { operations: { open: delayedOpen } },
    );
    await vi.waitFor(() => expect(writeStarted).toBe(true));
    expect(existsSync(resultPath)).toBe(false);
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".partial")))
      .toHaveLength(1);

    releaseWrite();
    await writing;

    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      ok: true,
      content: "Packaged PDF extraction works",
    });
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".partial")))
      .toEqual([]);
  } finally {
    releaseWrite();
    rmSync(directory, { recursive: true, force: true });
  }
});
