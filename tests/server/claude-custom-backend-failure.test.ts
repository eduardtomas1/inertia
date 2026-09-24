import { describe, expect, it } from "vitest";

import type { ModelBackendProfile } from "../../src/shared/contracts";
import {
  claudeRouteFailureDetail,
  claudeRouteFailureMessage,
} from "../../src/server/provider/claude-custom-backend-failure";
import { sanitizeProviderFailureDetail } from "../../src/server/provider/activity-detail";

// Characters that URL and base64 encodings actually change.
const credential = "q7Z2p9A/fixture+value=opaque";
const encoded = {
  base64: Buffer.from(credential, "utf8").toString("base64"),
  base64url: Buffer.from(credential, "utf8").toString("base64url"),
  url: encodeURIComponent(credential),
};
// A child that colours, resets or interleaves control characters inside a
// secret defeats an exact match that runs before those bytes are stripped.
const split = {
  ansiReset: `${credential.slice(0, 6)}\u001b[0m${credential.slice(6)}`,
  ansiColour: `${credential.slice(0, 10)}\u001b[31m${credential.slice(10)}`,
  control: `${credential.slice(0, 4)}\u0007${credential.slice(4, 12)}\u0000${credential.slice(12)}`,
};

const profile = {
  id: "custom-kimi",
  kind: "custom",
  label: "Kimi through Claude",
} as unknown as ModelBackendProfile;

function representations(): string[] {
  return [credential, ...Object.values(encoded), ...Object.values(split)];
}

describe("Claude custom-backend failure detail", () => {
  it("never retains a launch credential, split by terminal controls or encoded", () => {
    for (const representation of representations()) {
      const detail = claudeRouteFailureDetail({
        usesNativeAnthropic: false,
        rawError: `provider value ${representation} rejected`,
        message: "Kimi through Claude could not complete the request.",
        detail: "stderr tail",
        launchCredentials: [credential],
        workspaceRoot: "/workspace",
      });
      expect(detail, representation).not.toBeNull();
      expect(detail, representation).not.toContain(credential);
      for (const value of Object.values(encoded)) expect(detail, representation).not.toContain(value);
      expect(detail).toContain("[redacted]");
      expect(detail).toContain("stderr tail");
      // The runtime's later normalization does not receive the launch
      // credentials, so what leaves here must already be clean.
      expect(sanitizeProviderFailureDetail(detail, [])).not.toContain(credential);
    }
  });

  it("keeps the native route's detail and message untouched", () => {
    expect(claudeRouteFailureDetail({
      usesNativeAnthropic: true,
      rawError: `provider value ${split.ansiReset}`,
      message: "native message",
      detail: "native detail",
      launchCredentials: [credential],
      workspaceRoot: "/workspace",
    })).toBe("native detail");
    expect(claudeRouteFailureMessage(true, "native message", profile)).toBe("native message");
    expect(claudeRouteFailureDetail({
      usesNativeAnthropic: false,
      rawError: "same",
      message: "same",
      detail: null,
      launchCredentials: [],
      workspaceRoot: "/workspace",
    })).toBeNull();
  });
});

describe("provider failure detail", () => {
  it("strips controls before exact matching and covers every credential encoding", () => {
    for (const representation of representations()) {
      const detail = sanitizeProviderFailureDetail(
        `token=${representation} status=401`,
        [credential],
        { workspaceRoot: "/workspace" },
      );
      expect(detail, representation).not.toContain(credential);
      for (const value of Object.values(encoded)) expect(detail, representation).not.toContain(value);
    }
    expect(sanitizeProviderFailureDetail(undefined, [credential])).toBeNull();
    expect(sanitizeProviderFailureDetail("plain output", [])).toBe("plain output");
  });
});
