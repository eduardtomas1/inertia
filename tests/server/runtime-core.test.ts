import { describe, expect, it } from "vitest";

import { projectActionCommand } from "../../src/server/runtime-commands";
import { isAllowedRuntimeOrigin, parseRuntimeCommand } from "../../src/server/runtime-protocol";
import { initialProviderSnapshots, providerSnapshot } from "../../src/server/runtime-snapshots";

describe("runtime boundary helpers", () => {
  it("accepts only the desktop bundle and local development origins", () => {
    expect(isAllowedRuntimeOrigin("inertia://bundle")).toBe(true);
    expect(isAllowedRuntimeOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedRuntimeOrigin("https://127.0.0.1:4173")).toBe(true);
    expect(isAllowedRuntimeOrigin("https://example.com")).toBe(false);
    expect(isAllowedRuntimeOrigin("null")).toBe(false);
  });

  it("keeps wire decoding separate from command execution", () => {
    expect(parseRuntimeCommand(Buffer.from("not json"), false).error).toMatchObject({ message: "Command must be valid JSON." });
    expect(parseRuntimeCommand(Buffer.from("{}"), true).error).toMatchObject({ message: "Binary commands are not supported." });
    expect(parseRuntimeCommand(Buffer.from(JSON.stringify({ requestId: "known", type: "unknown", payload: {} })), false).error).toEqual({
      type: "request.error",
      requestId: "known",
      message: "Invalid command.",
    });
  });

  it("builds only allow-listed package script commands", () => {
    expect(projectActionCommand("npm", "test:unit")).toBe("npm run test:unit");
    expect(projectActionCommand("pnpm", "check")).toBe("pnpm run check");
    expect(() => projectActionCommand("npm", "test && whoami")).toThrow("cannot be run safely");
  });

  it("produces deterministic provider placeholders", () => {
    const providers = initialProviderSnapshots(true);
    expect(providers.map(({ id }) => id)).toEqual(["codex", "claude", "cursor", "opencode"]);
    expect(providers.every(({ canRun, installState, authState }) => !canRun && installState === "checking" && authState === "checking")).toBe(true);
  });

  it("preserves cached selector metadata while discovery is checking and after a failed refresh", () => {
    const metadata = {
      models: [{
        id: "model-a",
        label: "Model A",
        description: "Cached model",
        isDefault: true,
        inputModalities: ["text" as const],
        reasoningOptions: [],
        defaultReasoningEffort: "",
      }],
      rateLimits: [],
      metadataState: {
        models: { freshness: "stale" as const, provenance: "persistent-cache" as const, updatedAt: "2026-07-22T10:00:00.000Z", lastAttemptedAt: "2026-07-22T10:01:00.000Z", refreshing: false },
        rateLimits: { freshness: "unavailable" as const, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      },
    };
    const checking = initialProviderSnapshots(true, { codex: metadata }).find(({ id }) => id === "codex");
    expect(checking).toMatchObject({ models: [expect.objectContaining({ id: "model-a" })], metadataState: { models: { freshness: "stale" } } });

    const unavailable = providerSnapshot({
      provider: { id: "codex", name: "Codex", command: "codex" },
      available: false,
      installState: "error",
      authState: "unknown",
      canRun: false,
      statusMessage: "Discovery failed",
    }, metadata);
    expect(unavailable).toMatchObject({ models: [expect.objectContaining({ id: "model-a" })], metadataState: { models: { provenance: "persistent-cache" } } });
  });
});
