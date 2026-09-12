import type { ClientContext } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { configureKimiSession } from "../../src/server/provider/kimi-acp-session";

it("accepts an already selected advertised plan mode without changing it", async () => {
  const request = vi.fn();
  const context = { request } as unknown as ClientContext;
  const modes = { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] };
  await expect(configureKimiSession(context, "session", modes, [], "plan")).resolves.toEqual([]);
  await expect(configureKimiSession(context, "session", modes, [], "plan")).resolves.toEqual([]);
  expect(request).not.toHaveBeenCalled();
});

it("still rejects plan mode when no advertised plan route exists", async () => {
  const request = vi.fn();
  await expect(configureKimiSession({ request } as unknown as ClientContext, "session", {
    currentModeId: "build", availableModes: [{ id: "build", name: "Build" }],
  }, [], "plan")).rejects.toThrow("does not advertise a plan mode");
  expect(request).not.toHaveBeenCalled();
});
