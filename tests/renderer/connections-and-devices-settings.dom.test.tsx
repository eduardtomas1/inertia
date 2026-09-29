import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
