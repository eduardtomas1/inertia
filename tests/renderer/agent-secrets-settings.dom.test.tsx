import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import type { SecretRequestListEntry } from "../../src/shared/contracts/secret-request-results";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  AGENT_SECRETS_INTRO,
  AGENT_SECRETS_REFRESH_MS,
  AgentSecretsSettings,
} from "../../src/renderer/src/components/settings/sections/AgentSecretsSettings";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function entry(index: number, update: Partial<SecretRequestListEntry> = {}): SecretRequestListEntry {
  return {
    requestId: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${index}`,
    conversationId: `cccccccc-cccc-4ccc-8ccc-00000000000${index}`,
    conversationTitle: `CI tailnet ${index}`,
    title: `Tailscale auth key ${index}`,
    answeredAt: "2026-10-29T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    storage: "keychain",
    ...update,
  };
}

function listResult(secrets: SecretRequestListEntry[]): ServerEvent {
  return { type: "request.result", requestId: "list", result: { kind: "secret-request.list", secrets } } as ServerEvent;
}

function server(initial: SecretRequestListEntry[]) {
  let secrets = initial;
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "secret-request.list") return listResult(secrets);
    if (command.type === "secret-request.revoke") {
      secrets = secrets.filter(({ requestId }) => requestId !== command.payload.requestId);
      return { type: "request.result", requestId: "revoke", result: { kind: "secret-request.revoke", status: "revoked" } } as ServerEvent;
    }
    throw new Error(`Unexpected ${command.type}`);
  });
  return request;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Settings → Data → Agent secrets", () => {
  it("lists active secrets with chat, age, expiry and storage, and never a value or path", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const request = server([entry(1), entry(2, { storage: "memory", conversationTitle: "" })]);
    const open = vi.fn(() => true);
    render(<AgentSecretsSettings disabled={false} request={request} onOpenConversation={open} />);
    const group = screen.getByRole("region", { name: "Agent secrets" });
    expect(group).toHaveAttribute("data-setting-id", "agent-secrets");
    expect(group).toHaveTextContent(AGENT_SECRETS_INTRO);
    const list = await screen.findByRole("list", { name: "Active agent secrets" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Tailscale auth key 1");
    expect(rows[0]).toHaveTextContent("CI tailnet 1");
    expect(rows[0]).toHaveTextContent("Saved 2h ago · expires in 22h");
    expect(rows[0]).toHaveTextContent("System keychain");
    expect(rows[1]).toHaveTextContent("Untitled chat");
    expect(rows[1]).toHaveTextContent("Until Inertia quits");
    expect(request).toHaveBeenCalledWith({ type: "secret-request.list", payload: {} });
    expect(group.textContent).not.toMatch(/\/|tskey|agent-secrets\//u);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open chat CI tailnet 1" }));
    expect(open).toHaveBeenCalledWith(entry(1).conversationId);
  });

  it("shows the empty state", async () => {
    render(<AgentSecretsSettings disabled={false} request={server([])} />);
    expect(await screen.findByText("No agent secrets are active.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Revoke all" })).toBeNull();
  });

  it("revokes one secret, refreshes the list and keeps keyboard focus on the next row", async () => {
    const request = server([entry(1), entry(2)]);
    render(<AgentSecretsSettings disabled={false} request={request} />);
    const revoke = await screen.findByRole("button", { name: "Revoke Tailscale auth key 1" });
    revoke.focus();
    await act(async () => { fireEvent.click(revoke); });
    expect(request).toHaveBeenCalledWith({ type: "secret-request.revoke", payload: { requestId: entry(1).requestId } });
    await waitFor(() => expect(screen.queryByText("Tailscale auth key 1")).toBeNull());
    expect(screen.getByText("Secret revoked.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke Tailscale auth key 2" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Revoke all" })).toBeNull();
  });

  it("revokes every secret at once when two or more are active", async () => {
    const request = server([entry(1), entry(2), entry(3)]);
    render(<AgentSecretsSettings disabled={false} request={request} />);
    const all = await screen.findByRole("button", { name: "Revoke all" });
    all.focus();
    await act(async () => { fireEvent.click(all); });
    const revoked = request.mock.calls.flatMap(([command]) => command.type === "secret-request.revoke" ? [command.payload.requestId] : []);
    expect(revoked).toEqual([entry(1).requestId, entry(2).requestId, entry(3).requestId]);
    expect(await screen.findByText("No agent secrets are active.")).toHaveFocus();
    expect(screen.getByText("3 secrets revoked.")).toBeInTheDocument();
  });

  it("keeps revoking all when one listed secret expired meanwhile", async () => {
    const request = server([entry(1), entry(2), entry(3)]);
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command) => {
      if (command.type === "secret-request.revoke" && command.payload.requestId === entry(2).requestId) {
        throw new Error("That secret is no longer active.");
      }
      return await fallback(command);
    });
    render(<AgentSecretsSettings disabled={false} request={request} />);
    const all = await screen.findByRole("button", { name: "Revoke all" });
    await act(async () => { fireEvent.click(all); });
    const revoked = request.mock.calls.flatMap(([command]) => command.type === "secret-request.revoke" ? [command.payload.requestId] : []);
    expect(revoked).toEqual([entry(1).requestId, entry(2).requestId, entry(3).requestId]);
    expect(await screen.findByText("2 secrets revoked.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("revokes the rest but reports a secret whose file is still in use", async () => {
    const inUse = "A program is still using this secret's file, so Inertia couldn't delete it. Close it and try again.";
    const request = server([entry(1), entry(2), entry(3)]);
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command) => {
      if (command.type === "secret-request.revoke" && command.payload.requestId === entry(1).requestId) throw new Error(inUse);
      return await fallback(command);
    });
    render(<AgentSecretsSettings disabled={false} request={request} />);
    const all = await screen.findByRole("button", { name: "Revoke all" });
    await act(async () => { fireEvent.click(all); });
    expect(await screen.findByText(inUse)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Active agent secrets" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Tailscale auth key 1")).toBeInTheDocument();
  });

  it.each([
    ["That secret is no longer active.", "That secret is no longer active."],
    ["unlink failed at C:\\Users\\me\\agent-secrets\\token", "The secret could not be revoked."],
  ])("reports a single revoke failure with vetted copy only (%s)", async (thrown, shown) => {
    const request = server([entry(1)]);
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command) => {
      if (command.type === "secret-request.revoke") throw new Error(thrown);
      return await fallback(command);
    });
    render(<AgentSecretsSettings disabled={false} request={request} />);
    const revoke = await screen.findByRole("button", { name: "Revoke Tailscale auth key 1" });
    await act(async () => { fireEvent.click(revoke); });
    expect(await screen.findByText(shown)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Users");
  });

  it("does not revoke while settings are disabled", async () => {
    const request = server([entry(1)]);
    render(<AgentSecretsSettings disabled request={request} />);
    const revoke = await screen.findByRole("button", { name: "Revoke Tailscale auth key 1" });
    expect(revoke).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(revoke);
    expect(request.mock.calls.some(([command]) => command.type === "secret-request.revoke")).toBe(false);
  });

  it("reports an unreadable list and retries on request and on the refresh interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const request = vi.fn(async (): Promise<ServerEvent> => ({ type: "request.ok", requestId: "x" }));
    render(<AgentSecretsSettings disabled={false} request={request} />);
    expect(await screen.findByText("Agent secrets could not be read.")).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(AGENT_SECRETS_REFRESH_MS); });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
