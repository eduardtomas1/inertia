import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REMOTE_BROWSER_HEADERS } from "../../remote/browser/vite.config";
import {
  browserDeviceProfileSchema,
  validateBrowserRelayUrl,
} from "../../remote/browser/src/device-store";
import { appendRemoteText } from "../../remote/browser/src/safe-dom";
import { RemoteAccessSettings } from "../../src/renderer/src/components/RemoteAccessSettings";
import type { Conversation, Project } from "../../src/shared/contracts";
import type { RemoteDeviceUpdateRequest } from "../../src/shared/desktop";
import {
  remoteSafeMessageSchema,
  type RemoteAccessState,
} from "../../src/shared/remote-protocol";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

function pendingState(now: string): RemoteAccessState {
  return {
    available: true,
    enabled: true,
    relayUrl: "wss://relay.example/remote",
    connection: "online",
    connectionMessage: null,
    activeSessions: 0,
    devices: [],
    pendingPairings: [{
      requestId: crypto.randomUUID(),
      deviceLabel: "New browser",
      comparisonCode: "123456",
      receivedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      replacesDeviceLabel: null,
    }],
    invitation: null,
    audit: [],
  };
}

function pairedState(now: string, projectId: string): RemoteAccessState {
  return {
    ...pendingState(now),
    pendingPairings: [],
    devices: [{
      id: crypto.randomUUID(),
      label: "Paired browser",
      scopes: ["view", "prompt"],
      projectIds: [projectId],
      grants: [{
        projectId,
        conversationIds: [],
        includeFutureConversations: true,
        legacyProjectWide: false,
      }],
      needsGrantReview: false,
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    }],
  };
}

function projectFixture(id: string, now: string): Project {
  return {
    id,
    name: "Explicit project",
    path: "/not-rendered",
    normalizedPath: "/not-rendered",
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 4,
    color: "#000000",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  } as Project;
}

function conversationFixture(projectId: string, now: string): Conversation {
  return {
    id: crypto.randomUUID(),
    projectId,
    title: "Only conversation",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as Conversation;
}

describe("Remote Companion browser output boundary", () => {
  it("renders malicious provider output as inert text", () => {
    const parent = document.createElement("div");
    appendRemoteText(
      parent,
      "<img src=x onerror=alert(1)><script>alert(document.cookie)</script>",
    );

    expect(parent.querySelector("img")).toBeNull();
    expect(parent.querySelector("script")).toBeNull();
    expect(parent.textContent).toContain("<script>");
    expect(parent.innerHTML).toContain("&lt;script&gt;");
  });

  it("requires frame protection in the hosting response policy", () => {
    const html = readFileSync(
      resolve("remote/browser/index.html"),
      "utf8",
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("connect-src ws: wss:");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toContain("frame-ancestors");
    expect(REMOTE_BROWSER_HEADERS["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("strictly rejects corrupt stored device identities and excess capabilities", () => {
    const valid = {
      version: 1,
      deviceId: crypto.randomUUID(),
      deviceLabel: "Browser",
      keyPair: {
        publicKey: "safe_public_key",
        privateKey: "safe_private_key",
      },
      hostId: crypto.randomUUID(),
      hostPublicKey: "safe_host_key",
      relayUrl: "wss://relay.example/remote",
      endpointId: "safe_endpoint",
      scopes: ["view"],
      projectIds: [crypto.randomUUID()],
      grantVersion: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(browserDeviceProfileSchema.safeParse(valid).success).toBe(true);
    expect(validateBrowserRelayUrl("ws://[::1]:8787/remote")).toBe(
      "ws://[::1]:8787/remote",
    );
    expect(() => validateBrowserRelayUrl(
      "ws://relay.example/remote",
    )).toThrow("Use wss://");
    expect(browserDeviceProfileSchema.safeParse({
      ...valid,
      relayUrl: "javascript:alert(1)",
    }).success).toBe(false);
    expect(browserDeviceProfileSchema.safeParse({
      ...valid,
      keyPair: { ...valid.keyPair, privateKey: "../corrupt" },
    }).success).toBe(false);
    expect(browserDeviceProfileSchema.safeParse({
      ...valid,
      capabilities: ["full-access"],
    }).success).toBe(false);
    expect(remoteSafeMessageSchema.safeParse({
      id: "message",
      turnId: null,
      role: "system",
      content: "not projected",
      createdAt: new Date().toISOString(),
    }).success).toBe(false);
  });

  it("requires an explicit project choice before pairing approval", async () => {
    const now = new Date().toISOString();
    const state = pendingState(now);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
      },
    });
    render(<RemoteAccessSettings
      projects={[projectFixture(crypto.randomUUID(), now)]}
      conversations={[]}
    />);

    await screen.findByText("Approve New browser?");
    const project = screen.getByRole("checkbox", {
      name: "Explicit project",
    });
    expect(project).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Approve/u })).toBeDisabled();
    project.click();
    await waitFor(() => expect(screen.getByRole("checkbox", {
      name: /Include every conversation/u,
    })).not.toBeChecked());
    expect(screen.getByRole("button", { name: /Approve/u })).toBeDisabled();

    screen.getByRole("checkbox", {
      name: /Include every conversation/u,
    }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve/u })).toBeEnabled());
  });

  it("keeps approval blocked until a conversation is explicitly granted", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const state = pendingState(now);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
      },
    });
    render(<RemoteAccessSettings
      projects={[projectFixture(projectId, now)]}
      conversations={[conversationFixture(projectId, now)]}
    />);

    await screen.findByText("Approve New browser?");
    screen.getByRole("checkbox", { name: "Explicit project" }).click();
    await waitFor(() => expect(screen.getByRole("checkbox", {
      name: "Only conversation",
    })).not.toBeChecked());
    expect(screen.getByRole("button", { name: /Approve/u })).toBeDisabled();

    screen.getByRole("checkbox", { name: "Only conversation" }).click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve/u })).toBeEnabled());
  });

  it("limits prompt-capable pairing expiry to seven days", async () => {
    const now = new Date().toISOString();
    const state = pendingState(now);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
      },
    });
    render(<RemoteAccessSettings projects={[]} conversations={[]} />);

    await screen.findByText("Approve New browser?");
    screen.getByRole("switch", { name: "Allow text prompts" }).click();
    const expiry = screen.getByLabelText(
      "Permission expiry",
    ) as HTMLSelectElement;
    await waitFor(() => expect(expiry.value).toBe("7"));
    expect(expiry.querySelector('option[value="30"]')).toBeNull();
    expect(expiry.querySelector('option[value="90"]')).toBeNull();
  });

  it("saves an existing prompt device with a valid default expiry", async () => {
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const state = pairedState(now, projectId);
    const updateRemoteDevice = vi.fn(
      async (_request: RemoteDeviceUpdateRequest) => state,
    );
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
        updateRemoteDevice,
      },
    });
    render(<RemoteAccessSettings
      projects={[projectFixture(projectId, now)]}
      conversations={[]}
    />);

    await screen.findByText("Paired browser");
    screen.getByText("Edit permissions").click();
    const expiry = screen.getByLabelText("Reset expiry") as HTMLSelectElement;
    expect(expiry.value).toBe("7");
    expect(expiry.querySelector('option[value="30"]')).toBeNull();
    screen.getByRole("button", { name: "Save permissions" }).click();
    await waitFor(() => expect(updateRemoteDevice).toHaveBeenCalledOnce());
    const request = updateRemoteDevice.mock.calls[0]![0];
    const expiryMs = Date.parse(request.expiresAt) - Date.now();
    expect(request.scopes).toEqual(["view", "prompt"]);
    expect(expiryMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1_000);
    expect(expiryMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1_000);
  });
});
