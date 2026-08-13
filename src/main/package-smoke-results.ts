import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

type PackageSmokeReceiptKind = "PDF" | "image";

interface PackageSmokeResultWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

function validReceipt(value: unknown, kind: PackageSmokeReceiptKind): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.ok === false) {
    return typeof receipt.message === "string";
  }
  if (receipt.ok !== true) return false;
  return kind === "PDF"
    ? typeof receipt.content === "string"
    : Object.keys(receipt).length === 1;
}

export async function waitForPackageSmokeResult(
  path: string,
  kind: PackageSmokeReceiptKind,
  options: PackageSmokeResultWaitOptions = {},
): Promise<void> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 47_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (validReceipt(value, kind)) return;
      throw new Error(`The packaged ${kind} smoke receipt is invalid.`);
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  throw new Error(
    `The packaged ${kind} smoke receipt was not published before its deadline.`,
  );
}

export async function waitForRequestedPackageSmokeResults(
  paths: { readonly pdf: string | null; readonly image: string | null },
  options: PackageSmokeResultWaitOptions = {},
): Promise<void> {
  await Promise.all([
    paths.pdf
      ? waitForPackageSmokeResult(paths.pdf, "PDF", options)
      : Promise.resolve(),
    paths.image
      ? waitForPackageSmokeResult(paths.image, "image", options)
      : Promise.resolve(),
  ]);
}
