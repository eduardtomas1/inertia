// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";
import { readManagedClaudeUsage } from "../../src/server/provider/usage-context";
import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";
import type { ProviderManagerInstallationAuthority } from "../../src/server/provider/provider-manager-installation";

const metadata = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/provider/claude-agent-sdk-metadata", () => ({ readClaudeAgentSdkMetadata: metadata }));
vi.mock("../../src/server/environment", () => ({ providerEnvironment: async () => ({ env: {} }), providerChildEnvironment: () => ({}) }));
function fixture() {
  const admission = { id: "exact-admission" };
  const authority = { acquire: vi.fn(() => admission), operationIdentity: vi.fn(() => "operation"), release: vi.fn(() => true), quarantine: vi.fn() };
  return { admission, authority, read: () => readManagedClaudeUsage("fixture-claude", "/fixture", authority as unknown as ProviderManagerInstallationAuthority, new AbortController().signal) };
}
describe("Claude usage installation ownership", () => {
  it.each(["Claude metadata discovery timed out.", "Claude metadata discovery was cancelled.", "Malformed metadata"]) ("releases the exact admission after confirmed cleanup and %s", async (message) => {
    const f = fixture(); metadata.mockRejectedValueOnce(new Error(message));
    await expect(f.read()).rejects.toThrow(message);
    expect(f.authority.release).toHaveBeenCalledExactlyOnceWith(f.admission);
    expect(f.authority.quarantine).not.toHaveBeenCalled();
    metadata.mockResolvedValueOnce({ rateLimits: [] }); await f.read();
    expect(f.authority.release).toHaveBeenCalledTimes(2);
  });
  it("quarantines unconfirmed process cleanup without releasing it", async () => {
    const f = fixture(); const error = new ProcessTreeTerminationError("Claude fixture"); metadata.mockRejectedValueOnce(error);
    await expect(f.read()).rejects.toBe(error);
    expect(f.authority.release).not.toHaveBeenCalled();
    expect(f.authority.quarantine).toHaveBeenCalledExactlyOnceWith(f.admission, "claude-usage-cleanup-unconfirmed");
  });
  it("retains uncertainty when exact admission release fails", async () => {
    const f = fixture(); metadata.mockResolvedValueOnce({ rateLimits: [] }); f.authority.release.mockReturnValue(false);
    await expect(f.read()).rejects.toBeInstanceOf(ProcessTreeTerminationError);
    expect(f.authority.quarantine).toHaveBeenCalledExactlyOnceWith(f.admission, "claude-usage-release-unconfirmed");
  });
});
