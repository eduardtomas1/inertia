import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import type { ModelBackendProfileDetail } from "../../src/shared/contracts";

function profile(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  return {
    id: "custom:a",
    displayName: "Profile A",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: "endpoint:custom:a:1",
    preset: "custom",
    baseUrl: "https://custom-a.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "custom-a-model",
      displayName: "Profile A model",
      contextWindowTokens: 128_000,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "custom-a-model" },
    capabilityHints: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    endpointHost: "custom-a.example.test",
    authState: "configured",
    connectionState: "connected",
    compatibility: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:a",
      backendProtocol: "anthropic-messages",
      state: "verified",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "anthropic-probe-verified",
      reason: "The endpoint passed the compatibility probe.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  };
}

function settingsProps(
  overrides: Partial<ComponentProps<typeof ModelBackendsSettings>> = {},
): ComponentProps<typeof ModelBackendsSettings> {
  const detail = profile();
  return {
    profiles: [detail],
    disabled: false,
    onLoadDetail: vi.fn(async () => detail),
    onCreate: vi.fn(async () => detail),
    onUpdate: vi.fn(async () => detail),
    onSetCredential: vi.fn(async () => detail),
    onClearCredential: vi.fn(async () => detail),
    onProbe: vi.fn(async () => detail),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("model backend settings controls", () => {
  it("keeps the Model ID field focused while its identifier is typed", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...settingsProps()} />);
    await user.click(screen.getByRole("button", { name: "New profile" }));

    const modelId = screen.getByLabelText("Model ID");
    await user.click(modelId);
    await user.keyboard("{End}-next");

    expect(screen.getByLabelText("Model ID")).toHaveValue("custom-model-next");
    expect(screen.getByLabelText("Model ID")).toHaveFocus();
  });

  it("exposes the harness choice state and a keyboard-operable model mapping radio group", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...settingsProps()} />);
    await user.click(screen.getByRole("button", { name: "New profile" }));

    expect(screen.getByRole("button", { name: /Claude harness/u }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Codex harness/u }))
      .toHaveAttribute("aria-pressed", "false");

    const mapping = screen.getByRole("radiogroup", { name: "Model mapping" });
    const simple = within(mapping).getByRole("radio", { name: "Simple" });
    const advanced = within(mapping).getByRole("radio", { name: "Advanced" });
    expect(simple).toHaveAttribute("aria-checked", "true");
    expect(simple).toHaveAttribute("tabindex", "0");
    expect(advanced).toHaveAttribute("aria-checked", "false");
    expect(advanced).toHaveAttribute("tabindex", "-1");

    simple.focus();
    fireEvent.keyDown(simple, { key: "ArrowRight" });

    expect(advanced).toHaveFocus();
    expect(advanced).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Subagents")).toBeInTheDocument();

    fireEvent.keyDown(advanced, { key: "Home" });
    expect(simple).toHaveFocus();
    expect(simple).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText("Subagents")).not.toBeInTheDocument();
  });

  it("moves focus into the delete confirmation and back to Delete on cancel", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...settingsProps()} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    expect(screen.getByRole("button", { name: "Delete permanently" }))
      .toBeInTheDocument();

    await user.click(cancel);
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });
});
