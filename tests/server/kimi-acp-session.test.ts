import { RequestError, type ClientContext } from "@agentclientprotocol/sdk";
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

it("reselects the mode of a restored session whose advertised mode is stale", async () => {
  const modes = {
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
  };
  const already = vi.fn().mockRejectedValue(
    new RequestError(-32603, "Internal error", { details: "Already in plan mode" }),
  );
  await expect(configureKimiSession({ request: already } as unknown as ClientContext, "session", modes, [], "plan", undefined, undefined, undefined, true)).resolves.toEqual([]);
  const exit = vi.fn().mockResolvedValue({});
  await configureKimiSession({ request: exit } as unknown as ClientContext, "session", modes, [], "build", undefined, undefined, undefined, true);
  expect(exit).toHaveBeenCalledWith("session/set_mode", { sessionId: "session", modeId: "default" });
  const failed = vi.fn().mockRejectedValue(new RequestError(-32603, "Internal error", { details: "Mode switch failed" }));
  await expect(configureKimiSession({ request: failed } as unknown as ClientContext, "session", modes, [], "plan", undefined, undefined, undefined, true)).rejects.toThrow("Internal error");
});

it("reconfirms the model and effort of a restored session even when they are advertised as selected", async () => {
  const configOptions = [
    { id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "kimi-model", options: [{ value: "kimi-model", name: "Kimi model" }] },
    { id: "effort", name: "Thinking", category: "thought_level", type: "select" as const, currentValue: "high", options: [{ value: "high", name: "High" }] },
  ];
  const modes = { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] };
  const fresh = vi.fn().mockResolvedValue({ configOptions });
  await expect(configureKimiSession({ request: fresh } as unknown as ClientContext, "session", modes, configOptions, "build", "kimi-model", "high"))
    .resolves.toEqual(configOptions);
  expect(fresh).not.toHaveBeenCalled();
  const restored = vi.fn().mockResolvedValue({ configOptions });
  await configureKimiSession({ request: restored } as unknown as ClientContext, "session", modes, configOptions, "build", "kimi-model", "high", undefined, true);
  expect(restored.mock.calls).toEqual([
    ["session/set_config_option", { sessionId: "session", configId: "model", value: "kimi-model" }],
    ["session/set_config_option", { sessionId: "session", configId: "effort", value: "high" }],
  ]);
});
