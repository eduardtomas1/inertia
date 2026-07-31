import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { BrowserDeviceProfile } from "../../remote/browser/src/device-store";
import type { RemoteClientCallbacks } from "../../remote/browser/src/remote-client";
import type {
  RemoteSafeConversation,
  RemoteSafeConversationDetail,
  RemoteSafeShell,
} from "../../src/shared/remote-protocol";

interface RemoteBrowserAppHarness {
  callbacks: RemoteClientCallbacks | null;
  profile: BrowserDeviceProfile | null;
  selectConversation: Mock<(id: string) => void>;
  sendPrompt: Mock<
    (conversationId: string, content: string) => Promise<void>
  >;
}

const appHarness = vi.hoisted((): RemoteBrowserAppHarness => ({
  callbacks: null,
  profile: null,
  selectConversation: vi.fn(),
  sendPrompt: vi.fn(async () => undefined),
}));

vi.mock("../../remote/browser/src/remote-client", () => ({
  RemoteCompanionClient: class {
    constructor(callbacks: RemoteClientCallbacks) {
      appHarness.callbacks = callbacks;
    }

    initialize(): Promise<BrowserDeviceProfile | null> {
      return Promise.resolve(appHarness.profile);
    }

    currentProfile(): BrowserDeviceProfile | null {
      return appHarness.profile;
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    forget(): Promise<void> {
      return Promise.resolve();
    }

    pair(): Promise<void> {
      return Promise.resolve();
    }

    selectConversation(conversationId: string): void {
      appHarness.selectConversation(conversationId);
      appHarness.callbacks?.detail(null);
    }

    sendPrompt(conversationId: string, content: string): Promise<void> {
      return appHarness.sendPrompt(conversationId, content);
    }
  },
}));

afterEach(() => {
  appHarness.callbacks = null;
  appHarness.profile = null;
  appHarness.selectConversation.mockReset();
  appHarness.sendPrompt.mockReset();
  appHarness.sendPrompt.mockResolvedValue(undefined);
  document.body.replaceChildren();
  vi.resetModules();
});

describe("Remote Companion browser selection boundary", () => {
  it("removes the stale prompt form and submits only to the refreshed detail", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    appHarness.profile = {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Test browser",
      keyPair: {
        publicKey: "device_public",
        privateKey: "device_private",
      },
      hostId: crypto.randomUUID(),
      hostPublicKey: "host_public",
      relayUrl: "wss://relay.example/custom/path",
      endpointId: "opaque_endpoint",
      scopes: ["view", "prompt"],
      projectIds: [projectId],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const conversation = (
      id: string,
      title: string,
    ): RemoteSafeConversation => ({
      id,
      projectId,
      title,
      providerLabel: "Provider",
      status: "idle",
      pendingLocalApproval: false,
      updatedAt: now,
    });
    const first = conversation(firstId, "Conversation A");
    const second = conversation(secondId, "Conversation B");
    const shell: RemoteSafeShell = {
      generatedAt: now,
      projects: [{ id: projectId, name: "Project" }],
      conversations: [first, second],
      runs: [],
    };
    const detail = (
      value: RemoteSafeConversation,
    ): RemoteSafeConversationDetail => ({
      generatedAt: now,
      conversation: value,
      messages: [],
      activities: [],
      subagents: [],
      waitingForLocalAction: false,
    });
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);

    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail(first));
    expect(screen.getByLabelText("Text prompt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Conversation B · idle",
    }));
    expect(appHarness.selectConversation).toHaveBeenCalledWith(secondId);
    expect(screen.queryByLabelText("Text prompt")).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Send to desktop",
    })).toBeNull();

    appHarness.callbacks!.detail(detail(second));
    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "Continue B" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Send to desktop",
    }));
    expect(appHarness.sendPrompt).toHaveBeenCalledWith(
      secondId,
      "Continue B",
    );
    expect(appHarness.sendPrompt).not.toHaveBeenCalledWith(
      firstId,
      expect.anything(),
    );
  });
});
