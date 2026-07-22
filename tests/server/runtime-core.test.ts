import { describe, expect, it } from "vitest";

import { projectActionCommand } from "../../src/server/runtime-commands";
import { isAllowedRuntimeOrigin, parseRuntimeCommand } from "../../src/server/runtime-protocol";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";

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
});
