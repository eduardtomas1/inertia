import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserDeviceProfileSchema,
  validateBrowserRelayUrl,
} from "../../remote/browser/src/device-store";
import { appendRemoteText } from "../../remote/browser/src/safe-dom";
import { RemoteAccessSettings } from "../../src/renderer/src/components/RemoteAccessSettings";
import {
  remoteSafeMessageSchema,
  type RemoteAccessState,
} from "../../src/shared/remote-protocol";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

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

  it("ships a restrictive self-contained content security policy", () => {
    const html = readFileSync(
      resolve("remote/browser/index.html"),
      "utf8",
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("connect-src ws: wss:");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-ancestors 'none'");
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
    const state: RemoteAccessState = {
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
      }],
      invitation: null,
      audit: [],
    };
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
      },
    });
    render(<RemoteAccessSettings projects={[{
      id: crypto.randomUUID(),
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
    }]} />);

    await screen.findByText("Approve New browser?");
    const project = screen.getByRole("checkbox", {
      name: "Explicit project",
    });
    expect(project).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Approve/u })).toBeDisabled();
    project.click();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve/u })).toBeEnabled());
  });
});
