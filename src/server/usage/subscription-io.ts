import { createHmac } from "node:crypto";
import type { UsageAccount } from "../../shared/provider-usage-limits";

export type NativeUsageAccount = UsageAccount & {
  credentialFingerprint?: string;
  resumeUnavailable?: string;
};

const MAX_BYTES = 256 * 1024;

export class SubscriptionHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super("The provider could not report subscription limits.");
  }
}

function retryAfter(value: string | null): number | null {
  const header = value?.trim() ?? "";
  if (/^\d{1,9}$/u.test(header)) return Number(header) * 1_000;
  const at = Date.parse(header);
  return header && Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function subscriptionAccountIdentity(key: string, provider: string, credential: string): string {
  return createHmac("sha256", key).update(`inertia-subscription\0${provider}\0`).update(credential).digest("hex");
}

export async function subscriptionJson(fetcher: typeof fetch, url: string, token: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new SubscriptionHttpError(response.status, retryAfter(response.headers.get("retry-after")));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BYTES) throw new Error("The quota response was too large.");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
