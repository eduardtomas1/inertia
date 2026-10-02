import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { createHmac } from "node:crypto";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import type { UsageAccount } from "../../shared/provider-usage-limits";

export type NativeUsageAccount = UsageAccount & {
  credentialFingerprint?: string;
  keychain?: "deferred" | "read";
  resumeUnavailable?: string;
};

const MAX_BYTES = 256 * 1024;
export async function readSubscriptionFile(path: string): Promise<string | null> {
  try {
    const canonical = join(await realpath(dirname(path)), basename(path));
    const before = await lstat(canonical);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error();
    const file = await open(canonical, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw new Error();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await lstat(canonical);
      if (bytesRead > MAX_BYTES || after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) throw new Error();
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { buffer.fill(0); await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The provider's account configuration could not be read.");
  }
}
export function subscriptionAccountIdentity(key: string, provider: string, credential: string): string {
  return createHmac("sha256", key).update(`inertia-subscription\0${provider}\0`).update(credential).digest("hex");
}
export async function subscriptionJson(fetcher: typeof fetch, url: string, token: string, signal: AbortSignal,
  options: { post?: boolean; headers?: Record<string, string> } = {}): Promise<unknown> {
  const response = await fetcher(url, { method: options.post ? "POST" : "GET", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
    ...(options.post ? { body: "{}" } : {}) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("The provider could not report subscription limits."); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > MAX_BYTES) throw new Error("The quota response was too large.");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
