import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectModelDefault } from "../../src/renderer/src/components/ProjectModelDefault";
import { defaultSettings, type ModelBackendProfileView, type ModelSelection } from "../../src/shared/contracts";
import { provider } from "./composer-fixtures";

const profile: ModelBackendProfileView = {
  id: "custom:team", displayName: "Team gateway", protocol: "openai-responses",
  authenticationMode: "api-key", source: "custom", enabled: true, configurationRevision: 4,
  endpointIdentity: "opaque-team-route-4", harnessId: "codex-app-server", preset: "custom",
  allowInsecureLocalhost: false, credentialGeneration: null,
  models: [{ id: "team-alpha", displayName: "Team Alpha", contextWindowTokens: 120_000,
    reasoningOptions: [{ value: "medium", label: "Medium", description: "Balanced" },
      { value: "high", label: "High", description: "Thorough" }], capabilities: [] }],
  routing: { mode: "simple", primaryModelId: "team-alpha" }, capabilityHints: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  endpointHost: "example.invalid", authState: "configured", connectionState: "limited",
  compatibility: { harnessId: "codex-app-server", backendProfileId: "custom:team",
    backendProtocol: "openai-responses", state: "partially-compatible", provenance: "probe",
    allowsModelSwitchWithinSession: false, reasonCode: "responses-probe-verified", reason: "Verified exact route." },
  latestProbe: null, canDelete: true, canDisable: true,
};
const selection: ModelSelection = {
  harnessId: profile.harnessId, backendProfileId: profile.id, backendProfileDisplayName: profile.displayName,
  modelId: "team-alpha", alias: "Team Alpha", reasoningEffort: "medium", contextWindowOverride: 120_000,
  providerOptions: { custom_option: "preserved" }, capabilities: [], backendConfigurationRevision: 4,
};
function setup(profiles: ModelBackendProfileView[]) {
  const onChange = vi.fn();
  render(<ProjectModelDefault projectId="studio" providers={[provider]} backendProfiles={profiles}
    backendDefaults={[{ scope: "project", projectId: "studio", selection, updatedAt: profile.updatedAt }]}
    settings={defaultSettings} disabled={false} onChange={onChange} />);
  return onChange;
}
describe("project model defaults", () => {
  it("changes reasoning without losing the custom backend, revision, capabilities, or options", () => {
    const onChange = setup([profile]);
    const reasoning = screen.getByRole("combobox", { name: "Project default reasoning" });
    expect(reasoning).toBeEnabled();
    fireEvent.change(reasoning, { target: { value: "high" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...selection, reasoningEffort: "high" });
  });
  it("preserves an unavailable saved route and allows explicitly returning to inheritance", () => {
    const onChange = setup([]);
    expect(screen.getByRole("combobox", { name: "Project default reasoning" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Team Alpha — unavailable" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Project default model" }), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
