import { describe, expect, it } from "vitest";

import { ENDPOINT_CHALLENGE_TTL_MS } from "../remote/relay/endpoint-auth.mjs";
import {
  highestIntersection,
  negotiateCompatibility,
  type ComponentCompatibility,
  type ProtocolRange,
} from "../remote/relay/compatibility.mjs";
import { REMOTE_RELAY_CHALLENGE_TTL_MS } from "../src/main/remote-access-relay-registration";

const range = (minimum: number, maximum = minimum): ProtocolRange => ({
  minimum,
  maximum,
});

function component(
  kind: ComponentCompatibility["kind"],
  relayProtocol: ProtocolRange,
  remoteProtocol: ProtocolRange,
): ComponentCompatibility {
  return { kind, version: "0.2.0", relayProtocol, remoteProtocol };
}

describe("Remote Companion relay compatibility negotiation", () => {
  it("keeps the desktop clock check aligned with the supported relay TTL", () => {
    expect(REMOTE_RELAY_CHALLENGE_TTL_MS).toBe(ENDPOINT_CHALLENGE_TTL_MS);
  });

  it("selects the highest common relay and application versions", () => {
    expect(negotiateCompatibility({
      relay: component("relay", range(2, 4), range(2, 3)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(2, 3), range(1, 3)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(1, 3), range(2, 4)) as
        ComponentCompatibility & { kind: "browser" },
    })).toEqual({
      ok: true,
      selected: { relayProtocol: 3, remoteProtocol: 3 },
      versions: { relay: "0.2.0", desktop: "0.2.0", browser: "0.2.0" },
    });
    expect(highestIntersection([range(1, 4), range(2, 3), range(3, 5)])).toBe(3);
  });

  it("reports a newer browser with deterministic upgrade and downgrade paths", () => {
    expect(negotiateCompatibility({
      relay: component("relay", range(2, 3), range(2, 3)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(2), range(2)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(3), range(3)) as
        ComponentCompatibility & { kind: "browser" },
    })).toEqual({
      ok: false,
      incompatibility: {
        type: "relay.incompatible",
        axis: "relay-protocol",
        reason: "client-too-new",
        component: "browser",
        received: range(3),
        supported: range(2),
        guidance: [
          { action: "upgrade", component: "desktop", requiredProtocol: range(3) },
          { action: "downgrade", component: "browser", requiredProtocol: range(2) },
        ],
      },
    });
  });

  it("distinguishes relays that are too old or too new", () => {
    const oldRelay = negotiateCompatibility({
      relay: component("relay", range(2), range(2)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(3), range(3)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(3), range(3)) as
        ComponentCompatibility & { kind: "browser" },
    });
    expect(oldRelay).toMatchObject({
      ok: false,
      incompatibility: {
        axis: "relay-protocol",
        reason: "relay-too-old",
        component: "relay",
        guidance: [
          { action: "upgrade", component: "relay", requiredProtocol: range(3) },
          { action: "downgrade", component: "desktop", requiredProtocol: range(2) },
          { action: "downgrade", component: "browser", requiredProtocol: range(2) },
        ],
      },
    });

    const newRelay = negotiateCompatibility({
      relay: component("relay", range(3), range(3)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(2), range(2)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(2), range(2)) as
        ComponentCompatibility & { kind: "browser" },
    });
    expect(newRelay).toMatchObject({
      ok: false,
      incompatibility: {
        axis: "relay-protocol",
        reason: "relay-too-new",
        component: "relay",
        guidance: [
          { action: "upgrade", component: "desktop", requiredProtocol: range(3) },
          { action: "upgrade", component: "browser", requiredProtocol: range(3) },
          { action: "downgrade", component: "relay", requiredProtocol: range(2) },
        ],
      },
    });
  });

  it("reports application compatibility independently of relay transport", () => {
    expect(negotiateCompatibility({
      relay: component("relay", range(2), range(2, 4)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(2), range(2)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(2), range(3)) as
        ComponentCompatibility & { kind: "browser" },
    })).toMatchObject({
      ok: false,
      incompatibility: {
        axis: "remote-protocol",
        reason: "client-too-new",
        component: "browser",
      },
    });
  });

  it("rejects malformed, unknown, and prerelease descriptors", () => {
    expect(() => highestIntersection([range(3, 2)])).toThrow(
      "Invalid protocol compatibility range",
    );
    expect(() => negotiateCompatibility({
      relay: component("relay", range(2), range(2)) as
        ComponentCompatibility & { kind: "relay" },
      desktop: {
        ...component("desktop", range(2), range(2)),
        version: "0.3.0-beta.1",
      } as ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(2), range(2)) as
        ComponentCompatibility & { kind: "browser" },
    })).toThrow("Invalid desktop compatibility descriptor");
    expect(() => negotiateCompatibility({
      relay: {
        ...component("relay", range(2), range(2)),
        unexpected: true,
      } as ComponentCompatibility & { kind: "relay" },
      desktop: component("desktop", range(2), range(2)) as
        ComponentCompatibility & { kind: "desktop" },
      browser: component("browser", range(2), range(2)) as
        ComponentCompatibility & { kind: "browser" },
    })).toThrow("Invalid relay compatibility descriptor");
  });
});
