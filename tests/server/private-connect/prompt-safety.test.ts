import { describe, expect, it } from "vitest";

import {
  PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS,
  UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
  privateConnectPromptSafetyForHarness,
  privateConnectPromptSafetyIsUsable,
  privateConnectPromptSafetyLabel,
} from "../../../src/shared/private-connect/prompt-safety";

describe("Private Connect prompt safety", () => {
  it("advertises only known harness contracts", () => {
    expect(PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS).toContain("codex-app-server");
    expect(privateConnectPromptSafetyForHarness("codex-app-server").supported).toBe(true);
    expect(privateConnectPromptSafetyForHarness("unknown-harness" as never)).toBe(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY);
    expect(privateConnectPromptSafetyForHarness(null)).toBe(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY);
  });

  it("requires local action routing and rejects provider-controlled contracts", () => {
    const supported = privateConnectPromptSafetyForHarness("codex-app-server");
    expect(privateConnectPromptSafetyIsUsable(supported)).toBe(true);
    expect(privateConnectPromptSafetyIsUsable(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY)).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      permissionModel: "provider-controlled",
    })).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      networkPolicy: "unrestricted",
    })).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      filesystemPolicy: "unrestricted",
    })).toBe(false);
  });

  it("labels prompt capability without exposing provider output", () => {
    const safety = privateConnectPromptSafetyForHarness("opencode-sdk");
    expect(privateConnectPromptSafetyLabel("OpenCode", safety)).toContain("OpenCode Private Connect prompt");
    expect(privateConnectPromptSafetyLabel("OpenCode", safety)).toContain(safety.headline);
  });
});
