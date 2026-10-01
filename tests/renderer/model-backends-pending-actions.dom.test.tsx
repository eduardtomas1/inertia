import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import type {
  ModelBackendProfileDetail,
  ModelBackendProfileView,
} from "../../src/shared/contracts";

function profile(
  id: string,
  displayName: string,
  configurationRevision: number,
): ModelBackendProfileDetail {
  return {
    id,
    displayName,
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: false,
    configurationRevision,
    endpointIdentity: `endpoint:${id}:${configurationRevision}`,
    preset: "custom",
    baseUrl: `https://${id.replace(":", "-")}.example.test/v1`,
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: `${id}-model`,
      displayName: `${displayName} model`,
      contextWindowTokens: 128_000,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: `${id}-model` },
    capabilityHints: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    endpointHost: `${id.replace(":", "-")}.example.test`,
    authState: "missing",
    connectionState: "not-tested",
    compatibility: {
      harnessId: "claude-agent-sdk",
      backendProfileId: id,
      backendProtocol: "anthropic-messages",
      state: "unknown",
      provenance: "unknown",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-required",
      reason: "Test this backend before enabling it.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
  };
}

function settingsProps(
  profiles: ModelBackendProfileView[],
  onLoadDetail: (profileId: string) => Promise<ModelBackendProfileDetail>,
  onSetCredential: (
    profileId: string,
    secret: string,
  ) => Promise<ModelBackendProfileDetail>,
): ComponentProps<typeof ModelBackendsSettings> {
  const detail = async (profileId: string) => {
    const value = await onLoadDetail(profileId);
    return value;
  };
  return {
    profiles,
    defaults: [],
    projects: [],
    disabled: false,
    onLoadDetail: detail,
    onCreate: vi.fn(async () => {
      throw new Error("Unexpected create");
    }),
    onUpdate: vi.fn(async () => {
      throw new Error("Unexpected update");
    }),
    onSetCredential,
    onClearCredential: vi.fn(async () => {
      throw new Error("Unexpected credential clear");
    }),
    onProbe: vi.fn(async () => {
      throw new Error("Unexpected probe");
    }),
    onDelete: vi.fn(async () => undefined),
    onSetDefault: vi.fn(async () => undefined),
    onClearDefault: vi.fn(async () => undefined),
  };
}

describe("backend settings pending actions", () => {
  it("lands on a remaining profile when the snapshot drops a deleted profile before delete resolves", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const profileB = profile("custom:b", "Profile B", 1);
    const details = new Map([profileA, profileB].map((value) => [value.id, value]));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const props = {
      ...settingsProps([profileA, profileB], async (id) => details.get(id)!, vi.fn()),
      onDelete: vi.fn(() => pending),
    };
    const { container, rerender } = render(<ModelBackendsSettings {...props} />);
    await waitFor(() => expect(container.querySelector(".backend-identity-card")).toHaveTextContent("custom-a.example.test"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    rerender(<ModelBackendsSettings {...props} profiles={[profileB]} />);
    await act(async () => { finish(); await pending; });
    await waitFor(() => expect(container.querySelector(".backend-identity-card")).toHaveTextContent("custom-b.example.test"));
    const rail = screen.getByRole("complementary", { name: "Backend profiles" });
    expect(within(rail).getByTitle("Claude harness · Profile B")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("keeps Cancel reachable by keyboard while a save is pending", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const pending = new Promise<ModelBackendProfileDetail>(() => undefined);
    render(<ModelBackendsSettings
      {...settingsProps([profileA], async () => profileA, vi.fn())}
      onUpdate={vi.fn(() => pending)}
    />);
    await user.click(await screen.findByRole("button", { name: "Edit configuration" }));
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    screen.getByRole("button", { name: "Cancel profile editing" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });
});
