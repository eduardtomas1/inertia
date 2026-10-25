import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBackendProfiles } from "../../src/renderer/src/hooks/useBackendProfiles";
import { backendProbeFailure, backendProbePassed } from "../../src/renderer/src/utils/backendSettingsModel";
import type { ModelBackendProfileView } from "../../src/shared/contracts";
import { probeResult } from "./backend-view-fixtures";

function codexRoute(toolsVerified: boolean): Pick<ModelBackendProfileView, "latestProbe" | "models" | "protocol" | "routing"> {
  const probe = probeResult("custom:openai", "gpt-6.1-sol");
  return {
    protocol: "openai-responses",
    routing: { mode: "simple", primaryModelId: "gpt-6.1-sol" },
    latestProbe: null,
    models: [{
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
      compatibility: {
        harnessId: "codex-app-server",
        backendProfileId: "custom:openai",
        backendProtocol: "openai-responses",
        state: toolsVerified ? "verified" : "unavailable",
        provenance: "probe",
        allowsModelSwitchWithinSession: false,
        reasonCode: toolsVerified ? "responses-probe-verified" : "responses-tools-unverified",
        reason: "Codex needs a tool check.",
      },
      latestProbe: {
        ...probe,
        protocol: "openai-responses",
        capabilities: probe.capabilities.map((capability) => capability.id === "tools"
          ? { ...capability, state: toolsVerified ? "verified" : "unknown" }
          : capability),
      },
    }],
  };
}

describe("backend test outcome", () => {
  it("passes a Codex route only when its primary model verified tools", () => {
    expect(backendProbePassed(codexRoute(true))).toBe(true);
    expect(backendProbePassed(codexRoute(false))).toBe(false);
    expect(backendProbeFailure(codexRoute(false))).toBe("GPT-6.1 Sol: the model did not complete the tool check Codex needs.");
  });
});

describe("backend test outcome for a route that is still off", () => {
  it("judges a passing primary model by its probe while the route is off", () => {
    const route = codexRoute(true);
    const off = {
      ...route,
      models: route.models.map((model) => ({
        ...model,
        compatibility: { ...model.compatibility, state: "unavailable" as const, reasonCode: "profile-disabled" as const },
      })),
    };
    expect(backendProbePassed(off)).toBe(true);
  });
});

describe("backend credential errors", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "inertia");
  });

  it("strips the Electron IPC wrapper from vault errors", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        setBackendCredential: vi.fn(async () => {
          throw new Error("Error invoking remote method 'backend-credential:set': Error: The credential vault is locked.");
        }),
      },
    });
    const { result } = renderHook(() => useBackendProfiles({ request: vi.fn(), run: vi.fn() }));
    await expect(result.current.setBackendCredential("custom:a", "sk-test"))
      .rejects.toThrow(/^The credential vault is locked\.$/u);
  });

  it("reports a key the update removed as missing", async () => {
    const profile = { id: "custom:team", authState: "configured" };
    const run = vi.fn(async () => ({
      type: "request.result",
      requestId: "request",
      result: { kind: "backend.profile", profile, credentialCleared: true },
    }) as never);
    const { result } = renderHook(() => useBackendProfiles({ request: vi.fn(), run }));
    await expect(result.current.updateBackendProfile("custom:team", { baseUrl: "https://moved.example.test" }))
      .resolves.toMatchObject({ id: "custom:team", authState: "missing" });
  });
});
