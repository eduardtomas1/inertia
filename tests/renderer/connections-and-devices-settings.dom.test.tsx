import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionsAndDevicesSettings } from "../../src/renderer/src/components/ConnectionsAndDevicesSettings";
import { INTERFACE_LOCALE } from "../../src/renderer/src/lib/locale";
import type { PrivateConnectStateView } from "../../src/shared/private-connect/protocol";

const qr = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock("qrcode", () => ({ default: qr }));

function state(invitation: PrivateConnectStateView["invitation"]): PrivateConnectStateView {
  return {
    available: true,
    enabled: true,
    status: "ready",
    statusMessage: null,
    externalUrl: "https://inertia.example.ts.net",
    diagnostics: { tailscale: "connected", magicDns: "available", gatewayPort: null, servePort: null, externalUrl: null, mappingOwnership: "owned", errorClass: null },
    activeSessions: 0,
    devices: [],
    pendingPairings: [],
    invitation,
    notice: null,
  };
}

function installBridge(initial: PrivateConnectStateView, overrides: Record<string, unknown> = {}): {
  publish: (next: PrivateConnectStateView) => void;
} {
  let listener: ((next: PrivateConnectStateView) => void) | null = null;
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getPrivateConnectState: vi.fn(async () => initial),
      onPrivateConnectState: vi.fn((next: (value: PrivateConnectStateView) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
      ...overrides,
    },
  });
  return { publish: (next) => act(() => listener?.(next)) };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
  qr.toDataURL.mockReset();
});

describe("Connections and devices settings", () => {
  it("reports when a newly created pairing link expires", async () => {
    const expiresAt = "2030-01-01T10:05:00.000Z";
    const invitation = { url: "https://inertia.example.ts.net/pair#one", expiresAt };
    qr.toDataURL.mockResolvedValue("data:image/png;base64,one");
    installBridge(state(null), {
      createPrivateConnectInvitation: vi.fn(async () => invitation),
      getPrivateConnectState: vi.fn()
        .mockResolvedValueOnce(state(null))
        .mockResolvedValueOnce(state(invitation)),
    });
    render(<ConnectionsAndDevicesSettings projects={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Create pairing link" }));

    const time = new Date(expiresAt).toLocaleTimeString(INTERFACE_LOCALE);
    expect(await screen.findByText(`Pairing link ready until ${time}.`)).toHaveAttribute("role", "status");
  });

  it("keeps the QR code for the current pairing link when an older encode finishes last", async () => {
    const encodes = new Map<string, (value: string) => void>();
    qr.toDataURL.mockImplementation((url: string) =>
      new Promise<string>((resolve) => { encodes.set(url, resolve); }));
    const first = { url: "https://inertia.example.ts.net/pair#first", expiresAt: "2030-01-01T10:05:00.000Z" };
    const second = { url: "https://inertia.example.ts.net/pair#second", expiresAt: "2030-01-01T10:10:00.000Z" };
    const bridge = installBridge(state(first));
    render(<ConnectionsAndDevicesSettings projects={[]} />);
    await waitFor(() => expect(encodes.has(first.url)).toBe(true));

    bridge.publish(state(second));
    await waitFor(() => expect(encodes.has(second.url)).toBe(true));
    await act(async () => { encodes.get(second.url)!("data:image/png;base64,second"); });
    await act(async () => { encodes.get(first.url)!("data:image/png;base64,first"); });

    expect(screen.getByLabelText("Private Connect pairing link")).toHaveValue(second.url);
    expect(screen.getByAltText("Short-lived Private Connect pairing QR code"))
      .toHaveAttribute("src", "data:image/png;base64,second");
  });

  it("shows plain rows with real buttons, keeps the clicked button focused while busy and collapses the details", async () => {
    let finish!: (value: PrivateConnectStateView) => void;
    const setPrivateConnectEnabled = vi.fn(() => new Promise<PrivateConnectStateView>((resolve) => { finish = resolve; }));
    installBridge(state(null), { setPrivateConnectEnabled });
    const { container } = render(<ConnectionsAndDevicesSettings projects={[]} />);

    const toggle = await screen.findByRole("button", { name: "Disable" });
    expect(toggle).toHaveClass("secondary-button");
    expect(screen.getByRole("button", { name: "Create pairing link" })).toHaveClass("secondary-button");
    expect(container.querySelector(".settings-card-heading > div")).toBeNull();
    expect(container.textContent).not.toMatch(/[●↺]|\bQR\b/u);
    for (const summary of ["Security activity", "Advanced diagnostics"]) {
      expect(screen.getByText(summary).closest("details")).not.toHaveAttribute("open");
    }

    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(setPrivateConnectEnabled).toHaveBeenCalledOnce();
    await act(async () => finish({ ...state(null), enabled: false, status: "off" }));
    expect(await screen.findByText("Private Connect disabled.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Enable" })).not.toHaveAttribute("aria-disabled");
  });

  it("names the device access controls by their visible labels and reports failures as alerts", async () => {
    const device = {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Phone",
      preset: "monitor" as const,
      scopes: [],
      projectIds: [],
      grants: [],
      createdAt: "2030-01-01T00:00:00.000Z",
      lastSeenAt: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    };
    installBridge({ ...state(null), devices: [device] }, {
      revokePrivateConnectDevice: vi.fn(async () => { throw new Error("Revocation failed."); }),
    });
    render(<ConnectionsAndDevicesSettings projects={[]} />);
    expect(await screen.findByRole("combobox", { name: "Access Phone" })).toHaveValue("monitor");
    expect(screen.getByLabelText("Expires Phone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save access" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revocation failed.");
  });

  it("ends while a committed pairing link still waits for its QR encode effect", async () => {
    qr.toDataURL.mockResolvedValue("data:image/png;base64,pending");
    let listener: ((next: PrivateConnectStateView) => void) | null = null;
    installBridge(state(null), {
      onPrivateConnectState: vi.fn((next: (value: PrivateConnectStateView) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
    });
    render(<ConnectionsAndDevicesSettings projects={[]} />);
    await screen.findByRole("button", { name: "Create pairing link" });
    const committed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!screen.queryByLabelText("Private Connect pairing link")) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { subtree: true, childList: true });
    });

    listener!(state({ url: "https://inertia.example.ts.net/pair#pending", expiresAt: "2030-01-01T10:05:00.000Z" }));
    await committed;

    expect(qr.toDataURL).not.toHaveBeenCalled();
  });
});
