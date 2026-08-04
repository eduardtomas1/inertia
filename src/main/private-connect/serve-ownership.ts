import type { TailscaleServeMapping } from "./tailscale-status";

export const PRIVATE_CONNECT_SERVE_PORTS = [8443, 9443, 10443, 11443] as const;

export interface PrivateConnectServeOwnership {
  port: number;
  gatewayPort: number;
  target: string;
}

export function privateConnectServeTarget(gatewayPort: number): string {
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    throw new Error("The loopback gateway port is invalid.");
  }
  return `http://127.0.0.1:${gatewayPort}`;
}

export function mappingMatchesPrivateConnect(
  mapping: TailscaleServeMapping,
  ownership: PrivateConnectServeOwnership,
): boolean {
  return !mapping.funnel
    && mapping.port === ownership.port
    && mapping.target === ownership.target;
}

export function choosePrivateConnectServePort(
  mappings: readonly TailscaleServeMapping[],
  preferredPort: number | null,
): number | null {
  const occupied = new Set(mappings.map(({ port }) => port));
  const candidates: number[] = [
    ...(preferredPort === null ? [] : [preferredPort]),
    ...PRIVATE_CONNECT_SERVE_PORTS,
  ].filter((port) => port >= 1 && port <= 65_535);
  return [...new Set(candidates)].find((port) => !occupied.has(port)) ?? null;
}

export function privateConnectExternalUrl(
  dnsName: string,
  servePort: number,
): string {
  const host = dnsName.trim().replace(/\.$/u, "");
  if (!host || /[\s/?#]/u.test(host) || !Number.isInteger(servePort) || servePort < 1 || servePort > 65_535) {
    throw new Error("Tailscale Serve endpoint is invalid.");
  }
  return `https://${host}:${servePort}/`;
}
