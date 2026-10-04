import { describe, expect, it } from "vitest";

import {
  effectiveDefaultProviderId,
  type DefaultProviderState,
} from "../../src/shared/default-provider";
import type { ProviderId } from "../../src/shared/provider";

function state(
  id: ProviderId,
  overrides: Partial<Omit<DefaultProviderState, "id">> = {},
): DefaultProviderState {
  return {
    id,
    available: true,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    ...overrides,
  };
}

const notInstalled = { available: false, installState: "not-installed", authState: "unknown", canRun: false } as const;
const signedOut = { authState: "unauthenticated", canRun: false } as const;

describe("effective default provider", () => {
  it("keeps the stored provider while it can run", () => {
    expect(effectiveDefaultProviderId("codex", [state("codex"), state("claude")])).toBe("codex");
  });

  it("falls back to the first runnable provider in the app's order when the stored one is not installed", () => {
    expect(effectiveDefaultProviderId("codex", [
      state("codex", notInstalled),
      state("claude"),
      state("cursor"),
    ])).toBe("claude");
    expect(effectiveDefaultProviderId("codex", [
      state("codex", notInstalled),
      state("cursor"),
      state("claude"),
    ])).toBe("cursor");
  });

  it("falls back when the stored provider is installed but not connected", () => {
    expect(effectiveDefaultProviderId("codex", [state("codex", signedOut), state("claude")])).toBe("claude");
  });

  it.each([
    ["unresponsive", { installState: "unresponsive", canRun: false }],
    ["detection failed", { installState: "error", canRun: false }],
    ["connection issue", { authState: "error", canRun: false }],
    ["installed but unavailable", { available: false }],
    ["update required", { canRun: false }],
  ] as const)("falls back when the stored provider is %s", (_label, overrides) => {
    expect(effectiveDefaultProviderId("codex", [state("codex", overrides), state("claude")])).toBe("claude");
  });

  it("skips providers that are not installed, not connected or still checking", () => {
    expect(effectiveDefaultProviderId("codex", [
      state("codex", notInstalled),
      state("claude", signedOut),
      state("cursor", { installState: "checking", authState: "checking", canRun: false }),
      state("kimi", notInstalled),
      state("opencode"),
    ])).toBe("opencode");
  });

  it("keeps the stored provider while its own state is still being checked", () => {
    expect(effectiveDefaultProviderId("codex", [
      state("codex", { installState: "checking", authState: "checking", canRun: false }),
      state("claude"),
    ])).toBe("codex");
    expect(effectiveDefaultProviderId("codex", [
      state("codex", { authState: "checking", canRun: false }),
      state("claude"),
    ])).toBe("codex");
  });

  it("keeps the stored provider when no other provider can run", () => {
    expect(effectiveDefaultProviderId("claude", [
      state("codex", notInstalled),
      state("claude", signedOut),
    ])).toBe("claude");
    expect(effectiveDefaultProviderId("claude", [])).toBe("claude");
  });

  it("falls back when the stored provider is absent from a known provider list", () => {
    expect(effectiveDefaultProviderId("antigravity", [state("codex", notInstalled), state("claude")])).toBe("claude");
  });
});
