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
    (conversationId: string, content: string) => Promise<boolean>
  >;
}

const appHarness = vi.hoisted((): RemoteBrowserAppHarness => ({
  callbacks: null,
  profile: null,
  selectConversation: vi.fn(),
  sendPrompt: vi.fn(async () => true),
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

    sendPrompt(conversationId: string, content: string): Promise<boolean> {
      return appHarness.sendPrompt(conversationId, content);
    }
  },
}));

afterEach(() => {
  appHarness.callbacks = null;
  appHarness.profile = null;
  appHarness.selectConversation.mockReset();
  appHarness.sendPrompt.mockReset();
  appHarness.sendPrompt.mockResolvedValue(true);
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

    appHarness.callbacks!.detail(null);
    expect(screen.queryByLabelText("Text prompt")).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Send to desktop",
    })).toBeNull();
    expect(screen.getByText("Choose a conversation.")).toBeInTheDocument();
  });

  it("keeps an unsent prompt across live polling refreshes", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
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
    const conversation: RemoteSafeConversation = {
      id: conversationId,
      projectId,
      title: "Conversation A",
      providerLabel: "Provider",
      status: "idle",
      pendingLocalApproval: false,
      updatedAt: now,
    };
    const shell: RemoteSafeShell = {
      generatedAt: now,
      projects: [{ id: projectId, name: "Project" }],
      conversations: [conversation],
      runs: [],
    };
    const detail = (messageCount: number): RemoteSafeConversationDetail => ({
      generatedAt: new Date().toISOString(),
      conversation,
      messages: Array.from({ length: messageCount }, (_value, index) => ({
        id: `message-${index}`,
        turnId: null,
        role: "assistant" as const,
        content: `Agent line ${index}`,
        createdAt: now,
      })),
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
    appHarness.callbacks!.detail(detail(1));

    const field = screen.getByLabelText("Text prompt") as HTMLTextAreaElement;
    field.focus();
    fireEvent.change(field, { target: { value: "Half typed prompt" } });

    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail(2));

    const refreshed = screen.getByLabelText("Text prompt") as HTMLTextAreaElement;
    expect(refreshed.value).toBe("Half typed prompt");
    expect(document.activeElement).toBe(refreshed);

    fireEvent.click(screen.getByRole("button", {
      name: "Send to desktop",
    }));
    expect(appHarness.sendPrompt).toHaveBeenCalledWith(
      conversationId,
      "Half typed prompt",
    );

    await waitFor(() => expect(
      (screen.getByLabelText("Text prompt") as HTMLTextAreaElement).value,
    ).toBe(""));
    appHarness.callbacks!.detail(detail(3));
    expect(
      (screen.getByLabelText("Text prompt") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("keeps the prompt when the desktop does not accept it", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    appHarness.profile = {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Test browser",
      keyPair: { publicKey: "device_public", privateKey: "device_private" },
      hostId: crypto.randomUUID(),
      hostPublicKey: "host_public",
      relayUrl: "wss://relay.example/custom/path",
      endpointId: "opaque_endpoint",
      scopes: ["view", "prompt"],
      projectIds: [projectId],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    appHarness.sendPrompt.mockResolvedValue(false);
    const conversation: RemoteSafeConversation = {
      id: conversationId,
      projectId,
      title: "Conversation A",
      providerLabel: "Provider",
      status: "idle",
      pendingLocalApproval: false,
      updatedAt: now,
    };
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);

    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.shell({
      generatedAt: now,
      projects: [{ id: projectId, name: "Project" }],
      conversations: [conversation],
      runs: [],
    });
    appHarness.callbacks!.detail({
      generatedAt: now,
      conversation,
      messages: [],
      activities: [],
      subagents: [],
      waitingForLocalAction: false,
    });

    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "Unsent work" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Send to desktop",
    }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Send to desktop",
    })).toBeEnabled());
    expect(
      (screen.getByLabelText("Text prompt") as HTMLTextAreaElement).value,
    ).toBe("Unsent work");
  });
});
