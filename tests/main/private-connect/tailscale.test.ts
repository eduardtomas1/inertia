import { describe, expect, it } from "vitest";

import {
  choosePrivateConnectServePort,
  mappingMatchesPrivateConnect,
  privateConnectExternalUrl,
  privateConnectServeTarget,
} from "../../../src/main/private-connect/serve-ownership";
import {
  parseTailscaleServeStatus,
  parseTailscaleStatus,
} from "../../../src/main/private-connect/tailscale-status";

describe("Private Connect Tailscale ownership", () => {
  it("requires a running, addressed Tailscale backend", () => {
    expect(parseTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "desktop.example.ts.net.", TailnetName: "example", TailscaleIPs: ["100.64.0.2", "not-an-ip"] },
    })).toMatchObject({
      backendState: "Running",
      connected: true,
      dnsName: "desktop.example.ts.net",
      tailnetLabel: "example",
      addresses: ["100.64.0.2"],
    });
    expect(parseTailscaleStatus({ BackendState: "NeedsLogin", Self: { TailscaleIPs: [] } }).connected).toBe(false);
  });

  it("finds only exact non-Funnel loopback mappings", () => {
    const status = parseTailscaleServeStatus({
      Web: {
        "desktop.example.ts.net:8443": {
          "/": { Proxy: "http://127.0.0.1:41000" },
        },
      },
      Funnel: {
        "desktop.example.ts.net:443": {
          "/": { Proxy: "http://127.0.0.1:41000" },
        },
      },
    });
    expect(status.mappings).toContainEqual({
      host: "desktop.example.ts.net:8443",
      port: 8443,
      target: "http://127.0.0.1:41000",
      funnel: false,
    });
    expect(status.mappings.some((mapping) => mapping.funnel)).toBe(true);
    expect(mappingMatchesPrivateConnect(status.mappings[0]!, { port: 8443, gatewayPort: 41000, target: privateConnectServeTarget(41000) })).toBe(true);
    expect(choosePrivateConnectServePort(status.mappings, 8443)).toBe(9443);
    expect(privateConnectExternalUrl("desktop.example.ts.net", 8443)).toBe("https://desktop.example.ts.net:8443/");
  });
});
