export const RELAY_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });
export const REMOTE_PROTOCOL_RANGE = Object.freeze({ minimum: 2, maximum: 2 });

const COMPONENTS = new Set(["browser", "desktop", "relay"]);
const AXES = ["relay-protocol", "remote-protocol"];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function negotiateCompatibility(input) {
  if (!plainObject(input) || !exactKeys(input, 3)) {
    throw new TypeError("Compatibility negotiation requires three components.");
  }
  const components = [
    validateComponent(input.relay, "relay"),
    validateComponent(input.desktop, "desktop"),
    validateComponent(input.browser, "browser"),
  ];

  for (const axis of AXES) {
    const field = axis === "relay-protocol" ? "relayProtocol" : "remoteProtocol";
    const selected = highestIntersection(components.map((value) => value[field]));
    if (selected === null) {
      return {
        ok: false,
        incompatibility: incompatibility(axis, field, components),
      };
    }
  }

  return {
    ok: true,
    selected: {
      relayProtocol: highestIntersection(
        components.map(({ relayProtocol }) => relayProtocol),
      ),
      remoteProtocol: highestIntersection(
        components.map(({ remoteProtocol }) => remoteProtocol),
      ),
    },
    versions: {
      relay: input.relay.version,
      desktop: input.desktop.version,
      browser: input.browser.version,
    },
  };
}

export function highestIntersection(ranges) {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 3) {
    throw new TypeError("One to three protocol ranges are required.");
  }
  const validated = ranges.map(validateRange);
  const minimum = Math.max(...validated.map((value) => value.minimum));
  const maximum = Math.min(...validated.map((value) => value.maximum));
  return minimum <= maximum ? maximum : null;
}

function incompatibility(axis, field, components) {
  const highestMinimum = Math.max(...components.map((value) => value[field].minimum));
  const lowestMaximum = Math.min(...components.map((value) => value[field].maximum));
  const newer = components.filter(
    (value) => value[field].minimum === highestMinimum,
  );
  const relay = components.find(({ kind }) => kind === "relay");
  const desktop = components.find(({ kind }) => kind === "desktop");
  const browser = components.find(({ kind }) => kind === "browser");
  if (!relay || !desktop || !browser) {
    throw new TypeError("Relay, desktop, and browser components are required.");
  }

  let component;
  let reason;
  const relayOlderThanClients = relay[field].maximum
    < Math.min(desktop[field].minimum, browser[field].minimum);
  const relayNewerThanClients = relay[field].minimum
    > Math.max(desktop[field].maximum, browser[field].maximum);
  const relayDesktopMinimum = Math.max(
    relay[field].minimum,
    desktop[field].minimum,
  );
  const relayDesktopMaximum = Math.min(
    relay[field].maximum,
    desktop[field].maximum,
  );
  if (relayOlderThanClients) {
    component = relay;
    reason = "relay-too-old";
  } else if (relayNewerThanClients) {
    component = relay;
    reason = "relay-too-new";
  } else if (relayDesktopMinimum <= relayDesktopMaximum) {
    component = browser;
    reason = browser[field].minimum > relayDesktopMaximum
      ? "client-too-new"
      : "client-too-old";
  } else if (relay[field].maximum < desktop[field].minimum) {
    component = relay;
    reason = "relay-too-old";
  } else if (relay[field].minimum > desktop[field].maximum) {
    component = relay;
    reason = "relay-too-new";
  } else {
    component = newer.find(({ kind }) => kind !== "relay") ?? newer[0];
    reason = "client-too-new";
  }

  return {
    type: "relay.incompatible",
    axis,
    reason,
    component: component.kind,
    received: { ...component[field] },
    supported: reason.endsWith("too-old")
      ? { minimum: highestMinimum, maximum: highestMinimum }
      : { minimum: lowestMaximum, maximum: lowestMaximum },
    guidance: compatibilityGuidance(
      field,
      components,
      highestMinimum,
      lowestMaximum,
    ),
  };
}

function compatibilityGuidance(
  field,
  components,
  highestMinimum,
  lowestMaximum,
) {
  const guidance = [];
  for (const component of components) {
    if (component[field].maximum === lowestMaximum) {
      guidance.push({
        action: "upgrade",
        component: component.kind,
        requiredProtocol: {
          minimum: highestMinimum,
          maximum: highestMinimum,
        },
      });
    }
  }
  for (const component of components) {
    if (
      component[field].minimum === highestMinimum
      && !guidance.some(
        (value) => value.action === "upgrade" && value.component === component.kind,
      )
    ) {
      guidance.push({
        action: "downgrade",
        component: component.kind,
        requiredProtocol: {
          minimum: lowestMaximum,
          maximum: lowestMaximum,
        },
      });
    }
  }
  return guidance.slice(0, 3);
}

function validateComponent(value, expectedKind) {
  if (
    !plainObject(value)
    || !exactKeys(value, 4)
    || value.kind !== expectedKind
    || !COMPONENTS.has(value.kind)
    || typeof value.version !== "string"
    || value.version.length > 40
    || !SEMVER.test(value.version)
  ) throw new TypeError(`Invalid ${expectedKind} compatibility descriptor.`);
  return {
    kind: value.kind,
    version: value.version,
    relayProtocol: validateRange(value.relayProtocol),
    remoteProtocol: validateRange(value.remoteProtocol),
  };
}

function validateRange(value) {
  if (
    !plainObject(value)
    || !exactKeys(value, 2)
    || !Number.isSafeInteger(value.minimum)
    || !Number.isSafeInteger(value.maximum)
    || value.minimum < 1
    || value.maximum < value.minimum
  ) throw new TypeError("Invalid protocol compatibility range.");
  return { minimum: value.minimum, maximum: value.maximum };
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, count) {
  return Object.keys(value).length === count;
}
