import type { Provider } from "@opencode-ai/sdk/v2";

/** The SDK resolves environment, stored auth and workspace configuration. Do
 * not substitute a global Go login for a different effective model backend. */
export function openCodeSubscriptionCredential(inventory: { all: Provider[]; default: Record<string, string>; connected: string[] },
  model: string | undefined): { token: string; scope: string } | null {
  if (model && !model.startsWith("opencode-go/")) return null;
  const provider = inventory.all.find((entry) => entry.id === "opencode-go");
  const selectedId = model?.slice("opencode-go/".length) ?? inventory.default["opencode-go"];
  const selected = selectedId ? provider?.models[selectedId] : undefined;
  const options = provider?.options;
  const endpoint = options?.baseURL ?? selected?.api.url;
  const key = options?.apiKey ?? provider?.key;
  const headers = options?.headers;
  if (!inventory.connected.includes("opencode-go") || !selected || typeof endpoint !== "string"
    || endpoint.replace(/\/+$/u, "") !== "https://opencode.ai/zen/go/v1"
    || typeof key !== "string" || !key.trim() || key.length > 65536
    || (headers && typeof headers === "object" && Object.keys(headers).some((name) => name.toLowerCase() === "authorization"))) return null;
  return { token: key, scope: "opencode:go" };
}
