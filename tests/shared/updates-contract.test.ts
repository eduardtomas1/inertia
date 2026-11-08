import { describe, expect, it } from "vitest";
import { clientCommandSchema } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { runtimeCommandPolicy } from "../../src/renderer/src/utils/runtimeCommandPolicy";

const REQUEST = "11111111-1111-4111-8111-111111111111";

describe("update everything contract", () => {
  it("accepts the run and finish commands and refuses duplicate or unknown providers", () => {
    const run = { type: "updates.run", requestId: REQUEST, payload: { providerIds: ["codex", "claude"], includeApp: true, continueChats: false } };
    expect(clientCommandSchema.parse(run)).toEqual(run);
    expect(clientCommandSchema.parse({ type: "updates.finish", requestId: REQUEST, payload: { installed: false } }))
      .toEqual({ type: "updates.finish", requestId: REQUEST, payload: { installed: false } });
    expect(clientCommandSchema.safeParse({ ...run, payload: { ...run.payload, providerIds: ["codex", "codex"] } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ ...run, payload: { ...run.payload, providerIds: ["other"] } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ ...run, payload: { providerIds: [], includeApp: true } }).success).toBe(false);
  });

  it("validates the run result at the client boundary", () => {
    const result = {
      kind: "updates.run",
      providers: [{ providerId: "codex", outcome: "updated", beforeVersion: "0.112.0", afterVersion: "0.113.0", error: null }],
      interruptedConversationIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      readyForAppInstall: false,
      appInstallBlocker: "Close active terminals before restarting to update.",
    };
    expect(parseServerEvent({ type: "request.result", requestId: REQUEST, result })).toEqual({ type: "request.result", requestId: REQUEST, result });
    expect(parseServerEvent({ type: "request.result", requestId: REQUEST, result: { ...result, appInstallBlocker: null } }))
      .toMatchObject({ result: { appInstallBlocker: null } });
    expect(() => parseServerEvent({ type: "request.result", requestId: REQUEST, result: { ...result, readyForAppInstall: "yes" } })).toThrow();
    expect(() => parseServerEvent({ type: "request.result", requestId: REQUEST, result: { ...result, appInstallBlocker: 1 } })).toThrow();
    const { appInstallBlocker: _blocker, ...withoutBlocker } = result;
    expect(() => parseServerEvent({ type: "request.result", requestId: REQUEST, result: withoutBlocker })).toThrow();
    expect(() => parseServerEvent({
      type: "request.result", requestId: REQUEST,
      result: { ...result, providers: [{ ...result.providers[0], outcome: "maybe" }] },
    })).toThrow();
  });

  it("keeps the renderer pending through every provider update and treats a timeout as ambiguous", () => {
    expect(runtimeCommandPolicy("updates.run")).toEqual({ timeoutMs: 43 * 60_000, timeoutDelivery: "ambiguous" });
    expect(runtimeCommandPolicy("updates.finish")).toEqual({ timeoutMs: 15_000, timeoutDelivery: "ambiguous" });
  });
});
