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
  forget: Mock<() => Promise<void>>;
  pair: Mock<() => Promise<void>>;
}

const appHarness = vi.hoisted((): RemoteBrowserAppHarness => ({
  callbacks: null,
  profile: null,
  selectConversation: vi.fn(),
  sendPrompt: vi.fn(async () => true),
  forget: vi.fn(async () => undefined),
  pair: vi.fn(async () => undefined),
}));

vi.mock("../../remote/browser/src/remote-client", () => ({
  RemoteCompanionClient: class {
    constructor(callbacks: RemoteClientCallbacks) {
      appHarness.callbacks = callbacks;
    }

    initialize(): Promise<BrowserDeviceProfile | null> {
      appHarness.callbacks?.status(
        appHarness.profile ? "Connected." : "Paste an invitation.",
        appHarness.profile !== null,
      );
      return Promise.resolve(appHarness.profile);
    }

    currentProfile(): BrowserDeviceProfile | null {
      return appHarness.profile;
    }

    connect(): Promise<void> {
      return Promise.resolve();
    }

    forget(): Promise<void> {
      return appHarness.forget();
    }

    pair(): Promise<void> {
      return appHarness.pair();
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
  appHarness.forget.mockReset();
  appHarness.forget.mockResolvedValue(undefined);
  appHarness.pair.mockReset();
  appHarness.pair.mockResolvedValue(undefined);
  document.body.replaceChildren();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
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
      promptSafety: {
        supported: true,
        headline: "Local approval required for reported actions",
        explanation: "Desktop approval is required for reported actions.",
      },
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
      activities: [{
        id: "activity-1",
        turnId: null,
        kind: "status",
        title: "Reading safely",
        status: "running",
        createdAt: now,
      }],
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
    expect(screen.getByLabelText("Text prompt").closest("form")).not
      .toBeVisible();
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
    expect(screen.getByLabelText("Text prompt").closest("form")).not
      .toBeVisible();
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
      promptSafety: {
        supported: true,
        headline: "Local approval required for reported actions",
        explanation: "Desktop approval is required for reported actions.",
      },
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
      activities: [{
        id: "activity-1",
        turnId: null,
        kind: "status",
        title: "Reading safely",
        status: "running",
        createdAt: now,
      }],
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
    const checkedAt = new Date(Date.parse(now) + 2_000).toISOString();
    appHarness.callbacks!.freshness?.({
      checkedAt,
      resource: { kind: "conversation", conversationId },
    });
    expect(screen.getByText(
      `Last updated ${new Date(checkedAt).toLocaleString()}`,
    )).toBeVisible();
    expect(screen.getByLabelText("Text prompt")).toBe(field);
    field.focus();
    fireEvent.change(field, { target: { value: "Half typed prompt" } });
    field.setSelectionRange(5, 10);
    const navigationNode = screen.getByRole("button", {
      name: "Conversation A · idle",
    });
    const firstMessage = document.querySelector(
      '[data-remote-key="message:message-0"]',
    );
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    transcript.scrollTop = 300;
    const activityDisclosure = screen.getByText("Safe workstream (1)")
      .closest("details")!;
    activityDisclosure.open = true;

    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail(2));

    const refreshed = screen.getByLabelText("Text prompt") as HTMLTextAreaElement;
    expect(refreshed).toBe(field);
    expect(refreshed.value).toBe("Half typed prompt");
    expect(document.activeElement).toBe(refreshed);
    expect(refreshed.selectionStart).toBe(5);
    expect(refreshed.selectionEnd).toBe(10);
    expect(screen.getByRole("button", {
      name: "Conversation A · idle",
    })).toBe(navigationNode);
    expect(document.querySelector(
      '[data-remote-key="message:message-0"]',
    )).toBe(firstMessage);
    expect(screen.getByText("Safe workstream (1)").closest("details"))
      .toBe(activityDisclosure);
    expect(activityDisclosure.open).toBe(true);
    expect(transcript.scrollTop).toBe(300);

    (navigationNode as HTMLButtonElement).focus();
    appHarness.callbacks!.shell(shell);
    expect(document.activeElement).toBe(navigationNode);
    field.focus();

    fireEvent.change(refreshed, {
      target: { value: "Authority-bound draft" },
    });
    const retainedMessage = document.querySelector(
      '[data-remote-key="message:message-0"]',
    );
    const retainedActivity = document.querySelector(
      '[data-remote-key="activity-1"]',
    );
    appHarness.callbacks!.detail(null);
    expect(document.querySelector('[data-remote-key^="message:"]')).toBeNull();
    expect(document.querySelector('[data-remote-key="activity-1"]')).toBeNull();
    expect(document.body).not.toHaveTextContent("Agent line 0");
    expect(document.body).not.toHaveTextContent("Reading safely");
    expect(refreshed.value).toBe("");

    appHarness.callbacks!.detail(detail(2));
    expect(document.querySelector(
      '[data-remote-key="message:message-0"]',
    )).not.toBe(retainedMessage);
    expect(document.querySelector(
      '[data-remote-key="activity-1"]',
    )).not.toBe(retainedActivity);
    fireEvent.change(refreshed, { target: { value: "Half typed prompt" } });

    appHarness.callbacks!.status("The desktop is offline.", false);
    expect(screen.getByText(/Showing cached desktop data/u)).toBeVisible();
    expect(screen.getByText(/Cached · last updated/u)).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Conversation A · idle",
    })).toBe(navigationNode);
    expect(refreshed).toBeDisabled();
    expect(screen.getByRole("button", { name: "Offline" })).toBeDisabled();
    appHarness.callbacks!.status("Connected.", true);
    expect(refreshed).toBeEnabled();

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
      promptSafety: {
        supported: true,
        headline: "Local approval required for reported actions",
        explanation: "Desktop approval is required for reported actions.",
      },
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

  it("keeps one prompt operation owned across conversation selection", async () => {
    const { profile, shell, detail } = browserAuthorityFixture();
    const secondId = crypto.randomUUID();
    const secondConversation = {
      ...detail.conversation,
      id: secondId,
      title: "Second conversation",
    };
    appHarness.profile = profile;
    let settleFirst = (_accepted: boolean): void => undefined;
    const firstPrompt = new Promise<boolean>((resolve) => {
      settleFirst = resolve;
    });
    appHarness.sendPrompt.mockImplementationOnce(async () => await firstPrompt);
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.shell({
      ...shell,
      conversations: [...shell.conversations, secondConversation],
    });
    appHarness.callbacks!.detail(detail);

    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "First prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to desktop" }));
    expect(appHarness.sendPrompt).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", {
      name: "Second conversation · idle",
    }));
    appHarness.callbacks!.detail({
      ...detail,
      conversation: secondConversation,
    });
    const secondPrompt = screen.getByLabelText(
      "Text prompt",
    ) as HTMLTextAreaElement;
    fireEvent.change(secondPrompt, { target: { value: "Second prompt" } });
    const blocked = screen.getByRole("button", {
      name: "Another prompt is sending…",
    });
    expect(blocked).toBeDisabled();
    fireEvent.click(blocked);
    expect(appHarness.sendPrompt).toHaveBeenCalledOnce();
    appHarness.callbacks!.promptResult(
      "First prompt accepted.",
      false,
      detail.conversation.id,
    );
    expect(screen.queryByText("First prompt accepted.")).toBeNull();

    settleFirst(true);
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Send to desktop",
    })).toBeEnabled());
    expect(secondPrompt).toHaveValue("Second prompt");
    fireEvent.click(screen.getByRole("button", { name: "Send to desktop" }));
    expect(appHarness.sendPrompt).toHaveBeenLastCalledWith(
      secondId,
      "Second prompt",
    );
  });

  it("purges authorization-bound DOM and maps without forgetting the profile", async () => {
    const { profile, shell, detail } = browserAuthorityFixture();
    appHarness.profile = profile;
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail);
    fireEvent.change(screen.getByLabelText("Text prompt"), {
      target: { value: "Remove this draft" },
    });
    const oldMessage = document.querySelector(
      '[data-remote-key="message:secret-message"]',
    );
    const oldActivity = document.querySelector(
      '[data-remote-key="secret-activity"]',
    );
    const oldSubagent = document.querySelector(
      '[data-remote-key="secret-subagent"]',
    );

    appHarness.callbacks!.authorizationInvalidated?.();

    expect(screen.getByRole("heading", { name: "Authority browser" }))
      .toBeVisible();
    expect(screen.queryByRole("heading", { name: "Pair this browser" }))
      .toBeNull();
    expect(document.querySelector('[data-remote-key^="project:"]')).toBeNull();
    expect(document.querySelector('[data-remote-key^="conversation:"]'))
      .toBeNull();
    expect(document.querySelector('[data-remote-key^="message:"]')).toBeNull();
    expect(document.querySelector('[data-remote-key="secret-activity"]'))
      .toBeNull();
    expect(document.querySelector('[data-remote-key="secret-subagent"]'))
      .toBeNull();
    expect(document.body).not.toHaveTextContent("Secret project");
    expect(document.body).not.toHaveTextContent("Secret transcript");
    expect(document.body).not.toHaveTextContent("Secret activity");
    expect(document.body).not.toHaveTextContent("Secret agent");
    expect(screen.getByLabelText("Text prompt")).toHaveValue("");

    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail);
    expect(document.querySelector(
      '[data-remote-key="message:secret-message"]',
    )).not.toBe(oldMessage);
    expect(document.querySelector(
      '[data-remote-key="secret-activity"]',
    )).not.toBe(oldActivity);
    expect(document.querySelector(
      '[data-remote-key="secret-subagent"]',
    )).not.toBe(oldSubagent);
  });

  it("purges every identity-bound node after terminal invalidation", async () => {
    const { profile, shell, detail } = browserAuthorityFixture();
    appHarness.profile = profile;
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.shell(shell);
    appHarness.callbacks!.detail(detail);

    appHarness.profile = null;
    appHarness.callbacks!.invalidated?.();

    expect(screen.getByRole("heading", { name: "Pair this browser" }))
      .toBeVisible();
    expect(document.querySelector('[data-remote-key]')).toBeNull();
    expect(document.body).not.toHaveTextContent("Authority browser");
    expect(document.body).not.toHaveTextContent("Secret project");
    expect(document.body).not.toHaveTextContent("Secret conversation");
    expect(document.body).not.toHaveTextContent("Secret transcript");
    expect(document.body).not.toHaveTextContent("Secret activity");
    expect(document.body).not.toHaveTextContent("Secret agent");
    expect(screen.getByLabelText("Text prompt")).toHaveValue("");
  });

  it("reenables offline-first pairing on the browser online signal", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    const pair = screen.getByRole("button", { name: "Pair" });
    expect(pair).toBeDisabled();

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    expect(pair).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Invitation"), {
      target: { value: "fixture invitation" },
    });
    fireEvent.click(pair);
    await waitFor(() => expect(appHarness.pair).toHaveBeenCalledOnce());
  });

  it("keeps terminal truth and retry action across offline and online UI signals", async () => {
    const { profile } = browserAuthorityFixture();
    appHarness.profile = profile;
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());
    appHarness.callbacks!.connection?.({
      phase: "terminal",
      generation: 2,
      attempt: 1,
      retryAt: null,
      failure: {
        name: "RemoteConnectionFailure",
        message: "Protocol mismatch requires attention.",
        kind: "terminal",
        code: "protocol-mismatch",
      },
    });
    appHarness.callbacks!.status(
      "Protocol mismatch requires attention.",
      false,
    );

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
    expect(screen.getByText("Protocol mismatch requires attention."))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Retry connection" }))
      .toBeDisabled();

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    expect(screen.getByText("Protocol mismatch requires attention."))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Retry connection" }))
      .toBeEnabled();
  });

  it("disables reconnect and duplicate forget while identity clearing is pending", async () => {
    const { profile } = browserAuthorityFixture();
    appHarness.profile = profile;
    let rejectClear = (_error: Error): void => undefined;
    const clearing = new Promise<void>((_resolve, reject) => {
      rejectClear = reject;
    });
    appHarness.forget.mockImplementation(async () => {
      appHarness.callbacks!.forgetting?.(true);
      appHarness.callbacks!.status(
        "Disconnecting and forgetting this browser…",
        false,
      );
      try {
        await clearing;
      } catch (error) {
        appHarness.callbacks!.status(
          "Remote Companion is disconnected, but this browser could not be forgotten. Try again.",
          false,
        );
        throw error;
      } finally {
        appHarness.callbacks!.forgetting?.(false);
      }
    });
    const root = document.createElement("div");
    root.id = "app";
    document.body.append(root);
    await import("../../remote/browser/src/main");
    await waitFor(() => expect(appHarness.callbacks).not.toBeNull());

    fireEvent.click(screen.getByRole("button", {
      name: "Forget this browser",
    }));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forgetting…" }))
      .toBeDisabled();
    expect(appHarness.forget).toHaveBeenCalledOnce();

    rejectClear(new Error("vault unavailable"));
    await screen.findByText(/could not be forgotten/u);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forget this browser" }))
      .toBeEnabled();
    expect(appHarness.forget).toHaveBeenCalledOnce();
  });
});

function browserAuthorityFixture(): {
  profile: BrowserDeviceProfile;
  shell: RemoteSafeShell;
  detail: RemoteSafeConversationDetail;
} {
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();
  const conversation: RemoteSafeConversation = {
    id: crypto.randomUUID(),
    projectId,
    title: "Secret conversation",
    providerLabel: "Provider",
    status: "idle",
    pendingLocalApproval: false,
    promptSafety: {
      supported: true,
      headline: "Local approval required for reported actions",
      explanation: "Desktop approval is required for reported actions.",
    },
    updatedAt: now,
  };
  return {
    profile: {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Authority browser",
      keyPair: { publicKey: "device_public", privateKey: "device_private" },
      hostId: crypto.randomUUID(),
      hostPublicKey: "host_public",
      relayUrl: "wss://relay.example/remote",
      endpointId: "opaque_endpoint",
      scopes: ["view", "prompt"],
      projectIds: [projectId],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    shell: {
      generatedAt: now,
      projects: [{ id: projectId, name: "Secret project" }],
      conversations: [conversation],
      runs: [],
    },
    detail: {
      generatedAt: now,
      conversation,
      messages: [{
        id: "secret-message",
        turnId: null,
        role: "assistant",
        content: "Secret transcript",
        createdAt: now,
      }],
      activities: [{
        id: "secret-activity",
        turnId: null,
        kind: "status",
        title: "Secret activity",
        status: "running",
        createdAt: now,
      }],
      subagents: [{
        id: "secret-subagent",
        turnId: "secret-turn",
        providerLabel: "Secret agent",
        name: "Secret agent",
        status: "running",
        description: null,
        progress: null,
        updatedAt: now,
      }],
      waitingForLocalAction: false,
    },
  };
}
