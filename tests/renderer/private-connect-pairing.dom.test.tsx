import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/renderer/private-connect/src/App";
import { createPrivateConnectInvitation, createPrivateConnectPairingLink } from "../../src/shared/private-connect/pairing-link";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it("keeps the initiating nonce across a browser retry and uses it to poll approval", async () => {
  const starts: Array<Record<string, unknown>> = [];
  const polls: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/session/csrf") return new Response("{}", { status: 401 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path === "/api/pair/start") {
      starts.push(body);
      if (starts.length === 1) throw new TypeError("The connection dropped after pairing admission");
      return new Response(JSON.stringify({ requestId: "33333333-3333-4333-8333-333333333333", comparisonCode: "123456" }), { status: 202 });
    }
    if (path === "/api/pair/status") {
      polls.push(body);
      return new Response(JSON.stringify({ status: "pending" }));
    }
    throw new Error(`Unexpected endpoint ${path}`);
  }));
  const invitation = createPrivateConnectInvitation("11111111-1111-4111-8111-111111111111");
  const fragment = new URL(createPrivateConnectPairingLink("https://host.example", invitation)).hash;
  render(<StrictMode><App initialPairingFragment={fragment} /></StrictMode>);
  await screen.findByRole("heading", { name: "Your Inertia computer is offline" });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Waiting for approval" });
  await waitFor(() => expect(polls.length).toBeGreaterThan(0), { timeout: 2_500 });
  expect(starts.length).toBeGreaterThanOrEqual(2);
  expect(starts[0]!.browserNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(new Set(starts.map((request) => request.browserNonce)).size).toBe(1);
  expect(polls[0]).toEqual({ requestId: "33333333-3333-4333-8333-333333333333", browserNonce: starts[0]!.browserNonce });
  expect(document.body.textContent).not.toContain(starts[0]!.browserNonce);
});
