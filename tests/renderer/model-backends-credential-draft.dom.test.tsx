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

function credentialInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="password"]',
  );
  if (!input) throw new Error("Credential input is unavailable");
  return input;
}

describe("backend credential draft identity", () => {
  it.each(["probe", "clear", "enable", "save", "create", "delete"])(
    "keeps the selected profile and its credential draft after a background %s completes",
    async (operation) => {
      const user = userEvent.setup();
      const profileA = { ...profile("custom:a", "Profile A", 1), authState: "configured" as const };
      const profileB = profile("custom:b", "Profile B", 1);
      const profileC = profile("custom:c", "Profile C", 1);
      const details = new Map([profileA, profileB, profileC].map((value) => [value.id, value]));
      let finish!: (value: ModelBackendProfileDetail) => void;
      const pending = new Promise<ModelBackendProfileDetail>((resolve) => { finish = resolve; });
      const change = vi.fn(() => pending);
      const props = {
        ...settingsProps([profileA, profileC, profileB], async (id) => details.get(id)!, vi.fn()),
        onProbe: change,
        onClearCredential: change,
        onUpdate: change,
        onCreate: change,
        onDelete: async () => { await change(); },
      };
      const { container } = render(<ModelBackendsSettings {...props} />);
      await screen.findByRole("button", { name: "Test connection" });
      if (operation === "save") {
        await user.click(screen.getByRole("button", { name: "Edit configuration" }));
        await user.click(screen.getByRole("button", { name: "Save configuration" }));
      } else if (operation === "create") {
        await user.click(screen.getByRole("button", { name: "New profile" }));
        await user.click(screen.getByRole("button", { name: "Create profile" }));
      } else if (operation === "delete") {
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
      } else if (operation === "enable") {
        await user.click(screen.getByRole("switch", { name: "Enable Profile A" }));
      } else {
        await user.click(screen.getByRole("button", {
          name: operation === "probe" ? "Test connection" : "Clear backend credential",
        }));
      }
      expect(change).toHaveBeenCalledOnce();
      const rail = screen.getByRole("complementary", { name: "Backend profiles" });
      const profileBButton = within(rail).getByTitle("Claude harness · Profile B");
      await user.click(profileBButton);
      await waitFor(() => expect(container.querySelector(".backend-identity-card"))
        .toHaveTextContent("custom-b.example.test"));
      await user.type(credentialInput(container), "profile-b-draft");

      await act(async () => { finish(profileA); await pending; });

      expect(profileBButton).toHaveAttribute("aria-current", "true");
      expect(container.querySelector(".backend-identity-card"))
        .toHaveTextContent("custom-b.example.test");
      expect(credentialInput(container)).toHaveValue("profile-b-draft");
      expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
    },
  );

  it("does not present an old profile's probe failure after switching profiles", async () => {
    const user = userEvent.setup();
    const profileA = { ...profile("custom:a", "Profile A", 1), authState: "configured" as const };
    const profileB = profile("custom:b", "Profile B", 1);
    const details = new Map([profileA, profileB].map((value) => [value.id, value]));
    let reject!: (error: Error) => void;
    const onProbe = vi.fn(() => new Promise<ModelBackendProfileDetail>((_resolve, fail) => { reject = fail; }));
    render(<ModelBackendsSettings {...settingsProps(
      [profileA, profileB], async (id) => details.get(id)!, vi.fn(),
    )} onProbe={onProbe} />);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    await user.click(screen.getByTitle("Claude harness · Profile B"));

    await act(async () => { reject(new Error("Profile A endpoint is unavailable")); });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New profile" })).toBeEnabled();
  });

  it("does not reopen a completed creation after the user cancels its editor", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const created = profile("custom:new", "New profile", 1);
    let finish!: (value: ModelBackendProfileDetail) => void;
    const pending = new Promise<ModelBackendProfileDetail>((resolve) => { finish = resolve; });
    const props = {
      ...settingsProps([profileA], async (id) => id === profileA.id ? profileA : created, vi.fn()),
      onCreate: vi.fn(() => pending),
    };
    const { container, rerender } = render(<ModelBackendsSettings {...props} />);
    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await user.click(screen.getByRole("button", { name: "Cancel profile editing" }));
    await waitFor(() => expect(container.querySelector(".backend-identity-card"))
      .toHaveTextContent("custom-a.example.test"));
    await user.type(credentialInput(container), "profile-a-draft");
    // Runtime publication may add the profile before the create response arrives.
    rerender(<ModelBackendsSettings {...props} profiles={[profileA, created]} />);
    await act(async () => { finish(created); await pending; });

    const rail = screen.getByRole("complementary", { name: "Backend profiles" });
    expect(within(rail).getByTitle("Claude harness · Profile A"))
      .toHaveAttribute("aria-current", "true");
    expect(credentialInput(container)).toHaveValue("profile-a-draft");
  });

  it("clears a draft on profile switches and never saves it to the new profile", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const profileB = profile("custom:b", "Profile B", 1);
    const details = new Map([
      [profileA.id, profileA],
      [profileB.id, profileB],
    ]);
    const onLoadDetail = vi.fn(async (profileId: string) => details.get(profileId)!);
    const onSetCredential = vi.fn(async (profileId: string) => details.get(profileId)!);
    const { container } = render(
      <ModelBackendsSettings
        {...settingsProps(
          [profileA, profileB],
          onLoadDetail,
          onSetCredential,
        )}
      />,
    );
    await waitFor(() => expect(container.querySelector(
      'input[type="password"]',
    )).not.toBeNull());

    await user.type(credentialInput(container), "profile-a-secret");
    await user.click(screen.getByTitle("Claude harness · Profile B"));

    await waitFor(() => {
      expect(credentialInput(container)).toHaveValue("");
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    });
    expect(onSetCredential).not.toHaveBeenCalled();

    await user.type(credentialInput(container), "profile-b-secret");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(onSetCredential).toHaveBeenCalledWith(
        profileB.id,
        "profile-b-secret",
      );
    });
    expect(onSetCredential).not.toHaveBeenCalledWith(
      profileB.id,
      "profile-a-secret",
    );
  });

  it("clears and rejects a draft when the profile configuration revision changes", async () => {
    const user = userEvent.setup();
    const revisionOne = profile("custom:a", "Profile A", 1);
    let currentDetail = revisionOne;
    const onLoadDetail = vi.fn(async () => currentDetail);
    const onSetCredential = vi.fn(async () => currentDetail);
    const initialProps = settingsProps(
      [revisionOne],
      onLoadDetail,
      onSetCredential,
    );
    const { container, rerender } = render(
      <ModelBackendsSettings {...initialProps} />,
    );
    await waitFor(() => expect(container.querySelector(
      'input[type="password"]',
    )).not.toBeNull());
    await user.type(credentialInput(container), "revision-one-secret");

    currentDetail = profile("custom:a", "Profile A", 2);
    rerender(
      <ModelBackendsSettings
        {...settingsProps(
          [currentDetail],
          onLoadDetail,
          onSetCredential,
        )}
      />,
    );

    await waitFor(() => {
      expect(credentialInput(container)).toHaveValue("");
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    });
    expect(onSetCredential).not.toHaveBeenCalled();
  });

  it("ignores a deferred credential response after switching profiles", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const profileB = profile("custom:b", "Profile B", 1);
    const details = new Map([
      [profileA.id, profileA],
      [profileB.id, profileB],
    ]);
    let resolveCredential:
      | ((value: ModelBackendProfileDetail) => void)
      | null = null;
    const onLoadDetail = vi.fn(async (profileId: string) =>
      details.get(profileId)!);
    const onSetCredential = vi.fn(() =>
      new Promise<ModelBackendProfileDetail>((resolve) => {
        resolveCredential = resolve;
      }));
    const { container } = render(
      <ModelBackendsSettings
        {...settingsProps(
          [profileA, profileB],
          onLoadDetail,
          onSetCredential,
        )}
      />,
    );
    await waitFor(() => expect(container.querySelector(
      'input[type="password"]',
    )).not.toBeNull());

    await user.type(credentialInput(container), "profile-a-secret");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onSetCredential).toHaveBeenCalledWith(
      profileA.id,
      "profile-a-secret",
    ));

    const profileRail = screen.getByRole("complementary", {
      name: "Backend profiles",
    });
    const profileAButton = within(profileRail).getByTitle(
      "Claude harness · Profile A",
    );
    const profileBButton = within(profileRail).getByTitle(
      "Claude harness · Profile B",
    );
    await user.click(profileBButton);
    await waitFor(() => {
      expect(profileBButton).toHaveAttribute("aria-current", "true");
      expect(container.querySelector(".backend-identity-card"))
        .toHaveTextContent("custom-b.example.test");
    });

    await act(async () => {
      resolveCredential?.({
        ...profileA,
        authState: "configured",
        credentialGeneration: "credential-generation-1",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(profileBButton).toHaveAttribute("aria-current", "true");
      expect(profileAButton).not.toHaveAttribute("aria-current");
      expect(container.querySelector(".backend-identity-card"))
        .toHaveTextContent("custom-b.example.test");
    });
  });
});
