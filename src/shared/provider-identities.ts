import type { ProviderId } from "./provider";

const PROVIDER_IDS = new Set<ProviderId>([
  "codex", "claude", "cursor", "opencode",
]);

export type ProviderIdentityLabels = Partial<Record<ProviderId, string>>;

export function parseProviderIdentityLabels(
  value: unknown,
): ProviderIdentityLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider identity labels must be an object.");
  }
  const labels: ProviderIdentityLabels = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!PROVIDER_IDS.has(key as ProviderId) || typeof raw !== "string") {
      throw new Error("Provider identity labels contain an invalid provider.");
    }
    const label = raw.trim();
    if (!label || label.length > 48 || /[\0\r\n]/u.test(label)) {
      throw new Error(
        "Provider identity labels must contain 1 to 48 safe characters.",
      );
    }
    labels[key as ProviderId] = label;
  }
  return labels;
}
