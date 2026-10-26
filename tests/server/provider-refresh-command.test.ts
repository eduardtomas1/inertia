import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import type { ProviderMaintenanceController } from "../../src/server/provider/maintenance-controller";
import type { ProviderManager } from "../../src/server/providers";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  createProviderCommandHandler,
  type ProviderCommandDependencies,
} from "../../src/server/runtime/commands/provider-commands";
import type { ManualUsageRefreshOutcome } from "../../src/server/runtime/provider-usage-refresh";
import type { TerminalManager } from "../../src/server/terminal";
import type { AppSnapshot } from "../../src/shared/contracts";

const requestId = "33333333-3333-4333-8333-333333333333";
const socket = {} as WebSocket;

function handler(outcome: ManualUsageRefreshOutcome) {
  const dependencies = {
    providers: {} as ProviderManager,
    providerMaintenance: {
      refresh: vi.fn(async () => []),
    } as unknown as ProviderMaintenanceController,
    terminals: {} as TerminalManager,
    defaultWorkspacePath: "/workspace",
    currentSnapshot: () => ({}) as AppSnapshot,
    refreshProviderInfo: vi.fn(async () => undefined),
    refreshProviderUsage: vi.fn(async () => outcome),
    send: vi.fn(),
  } satisfies ProviderCommandDependencies;
  return { dependencies, handle: createProviderCommandHandler(dependencies) };
}

describe("provider.refresh for usage", () => {
  it("answers from a quota read without re-detecting the provider", async () => {
    const { dependencies, handle } = handler("updated");
    await expect(handle(socket, {
      type: "provider.refresh",
      requestId,
      payload: { providerId: "claude", scope: "usage" },
    })).resolves.toBe("handled");
    expect(dependencies.refreshProviderUsage).toHaveBeenCalledWith("claude");
    expect(dependencies.refreshProviderInfo).not.toHaveBeenCalled();
    expect(dependencies.providerMaintenance.refresh).not.toHaveBeenCalled();
    expect(dependencies.send).toHaveBeenCalledWith(socket, { type: "request.ok", requestId });
  });

  it("rejects the request when the provider did not report usage", async () => {
    const { dependencies, handle } = handler("failed");
    const refresh = handle(socket, {
      type: "provider.refresh",
      requestId,
      payload: { providerId: "claude", scope: "usage" },
    });
    await expect(refresh).rejects.toBeInstanceOf(RuntimeRequestError);
    await expect(refresh).rejects.toThrow("The provider did not report usage. Try again in a moment.");
    expect(dependencies.refreshProviderInfo).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it("falls back to the full refresh when the provider has no readable quota", async () => {
    const { dependencies, handle } = handler("unsupported");
    await handle(socket, {
      type: "provider.refresh",
      requestId,
      payload: { providerId: "cursor", scope: "usage" },
    });
    expect(dependencies.refreshProviderInfo).toHaveBeenCalledWith("cursor", true, true);
    expect(dependencies.providerMaintenance.refresh).toHaveBeenCalledWith(["cursor"], true);
    expect(dependencies.send).toHaveBeenCalledWith(socket, { type: "request.ok", requestId });
  });

  it("keeps the full refresh for requests without the usage scope", async () => {
    const { dependencies, handle } = handler("updated");
    await handle(socket, {
      type: "provider.refresh",
      requestId,
      payload: { providerId: "claude" },
    });
    expect(dependencies.refreshProviderUsage).not.toHaveBeenCalled();
    expect(dependencies.refreshProviderInfo).toHaveBeenCalledWith("claude", true, true);
  });
});
