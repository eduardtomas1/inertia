import { isIP } from "node:net";

import { z } from "zod";

const hostName = z.string().trim().min(1).max(253);

export interface TailscaleStatus {
  backendState: "Running" | "Stopped" | "NeedsLogin" | "NeedsMachineAuth" | "Unknown";
  connected: boolean;
  dnsName: string | null;
  tailnetLabel: string | null;
  addresses: string[];
}

export interface TailscaleServeMapping {
  host: string | null;
  port: number;
  target: string | null;
  funnel: boolean;
}

export interface TailscaleServeStatus {
  mappings: TailscaleServeMapping[];
}

export function parseTailscaleStatus(value: unknown): TailscaleStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tailscale status was not an object.");
  }
  const record = value as Record<string, unknown>;
  const backendState = normalizeBackendState(record.BackendState);
  const self = objectValue(record.Self);
  const dnsName = normalizeDnsName(self?.DNSName ?? record.DNSName);
  const addresses = normalizeAddresses(self?.TailscaleIPs ?? record.TailscaleIPs);
  const tailnetLabel = normalizeTailnetLabel(
    self?.TailnetName ?? self?.Tailnet ?? record.TailnetName,
  );
  return {
    backendState,
    connected: backendState === "Running" && addresses.length > 0,
    dnsName,
    tailnetLabel,
    addresses,
  };
}

export function parseTailscaleServeStatus(value: unknown): TailscaleServeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tailscale Serve status was not an object.");
  }
  const mappings: TailscaleServeMapping[] = [];
  collectServeMappings(value, mappings, null, false);
  return { mappings: deduplicateMappings(mappings) };
}

function collectServeMappings(
  value: unknown,
  mappings: TailscaleServeMapping[],
  host: string | null,
  funnel: boolean,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectServeMappings(item, mappings, host, funnel);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childFunnel = funnel || /funnel/iu.test(key);
    const url = /[.:]/u.test(key) ? parseHttpsEndpoint(key) : null;
    if (url) {
      collectServeMappings(child, mappings, `${url.hostname}:${url.port || 443}`, childFunnel);
      continue;
    }
    const record = child && typeof child === "object" && !Array.isArray(child)
      ? child as Record<string, unknown>
      : null;
    if (record) {
      const target = firstString(record.Target, record.target, record.Proxy, record.proxy, record.Handler);
      const port = firstPort(
        record.Port,
        record.port,
        record.HTTPSPort,
        record.httpsPort,
        host ? (parseHttpsEndpoint(`https://${host}`)?.port || 443) : null,
      );
      if (target !== null && port !== null) {
        mappings.push({
          host,
          port,
          target: normalizeTarget(target),
          funnel: childFunnel || Boolean(record.Funnel ?? record.funnel),
        });
      }
    }
    collectServeMappings(child, mappings, host, childFunnel || Boolean(record?.Funnel ?? record?.funnel));
  }
}

function deduplicateMappings(mappings: TailscaleServeMapping[]): TailscaleServeMapping[] {
  const seen = new Set<string>();
  return mappings.filter((mapping) => {
    const key = JSON.stringify(mapping);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeBackendState(value: unknown): TailscaleStatus["backendState"] {
  return value === "Running" || value === "Stopped"
    || value === "NeedsLogin" || value === "NeedsMachineAuth"
    ? value
    : "Unknown";
}

function normalizeDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().replace(/\.$/u, "");
  if (!candidate || candidate.length > 253 || candidate.includes("/") || candidate.includes(":")) return null;
  return hostName.safeParse(candidate).success ? candidate : null;
}

function normalizeTailnetLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= 120 ? candidate : null;
}

function normalizeAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((candidate): candidate is string =>
    typeof candidate === "string" && isIP(candidate.trim()) !== 0,
  ).map((candidate) => candidate.trim()))].slice(0, 8);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 2_048,
  )?.trim() ?? null;
}

function firstPort(...values: unknown[]): number | null {
  for (const value of values) {
    const port = typeof value === "string" ? Number(value) : value;
    if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
  }
  return null;
}

function parseHttpsEndpoint(value: string): URL | null {
  try {
    const url = new URL(value.startsWith("https://") ? value : `https://${value}`);
    return url.protocol === "https:" && url.hostname.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function normalizeTarget(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return null;
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/") return null;
    return `http://127.0.0.1:${url.port}`;
  } catch {
    return null;
  }
}
