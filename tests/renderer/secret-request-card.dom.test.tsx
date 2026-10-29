import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SaveAgentSecretRequest,
  SaveAgentSecretResult,
  SecretRequestReference,
  SecretRequestStatus,
} from "../../src/shared/agent-secrets";
import type { ServerEvent } from "../../src/shared/contracts";
import { SecretRequestCard, SecretRequestList } from "../../src/renderer/src/components/response-timeline/SecretRequestCard";
import { SecretRequestContext } from "../../src/renderer/src/components/response-timeline/secretRequestContext";
import type { SecretRequestCommandRunner, SecretRequestMessage } from "../../src/renderer/src/utils/response-timeline/secretRequests";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "tskey-auth-k7Qx9-SECRET-VALUE";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
let requestCounter = 0;

function reference(update: Partial<SecretRequestReference> = {}): SecretRequestReference {
  return {
    requestId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(requestCounter).padStart(12, "0")}`,
    title: "Tailscale auth key",
    description: "Create a reusable, ephemeral key at https://login.tailscale.com/admin/settings/keys.\nTag it tag:ci.",
    ttlHours: 24,
    status: "pending",
    answeredAt: null,
    expiresAt: null,
    storage: null,
    ...update,
  };
}

function message(secretRequest: SecretRequestReference): SecretRequestMessage {
  return {
    id: `message-${secretRequest.requestId}`,
    conversationId: CONVERSATION_ID,
    turnId: "turn-1",
    role: "system",
    content: `Asked for a secret: ${secretRequest.title}`,
    attachments: [],
    createdAt: "2026-10-29T11:59:00.000Z",
    secretRequest,
  };
}

function settled(status: SecretRequestStatus, update: Partial<SecretRequestReference> = {}): SecretRequestReference {
  const answered = status === "saved" || status === "expired" || status === "revoked";
  return reference({
    status,
    answeredAt: status === "pending" ? null : "2026-10-29T11:59:30.000Z",
    expiresAt: answered ? "2026-10-30T11:59:30.000Z" : null,
    storage: answered ? "keychain" : null,
    ...update,
  });
}

const resultEvent = { type: "request.ok", requestId: "ok" } as ServerEvent;
let onCommand: ReturnType<typeof vi.fn<SecretRequestCommandRunner>>;
type SaveAgentSecret = (request: SaveAgentSecretRequest) => Promise<SaveAgentSecretResult>;
const SAVED: SaveAgentSecretResult = { status: "saved", expiresAt: "2026-10-30T12:00:00.000Z", storage: "keychain" };
let saveAgentSecret: ReturnType<typeof vi.fn<SaveAgentSecret>>;

function installBridge(bridge: Record<string, unknown> | undefined): void {
  Object.defineProperty(window, "inertia", { configurable: true, writable: true, value: bridge });
}

function workspace(
  children: React.ReactNode,
  { composer = "", runner }: { composer?: string; runner?: SecretRequestCommandRunner | null } = {},
): React.JSX.Element {
  return (
    <div className="chat-workspace">
      <SecretRequestContext.Provider value={{ conversationId: CONVERSATION_ID, onCommand: runner === null ? undefined : runner ?? onCommand }}>
        {children}
      </SecretRequestContext.Provider>
      <section aria-label="Message composer">
        <textarea aria-label="Message" defaultValue={composer} />
      </section>
    </div>
  );
}

function input(): HTMLInputElement {
  return screen.getByLabelText("Tailscale auth key", { selector: "input" }) as HTMLInputElement;
}

beforeEach(() => {
  requestCounter += 1;
  onCommand = vi.fn<SecretRequestCommandRunner>(async () => resultEvent);
  saveAgentSecret = vi.fn<SaveAgentSecret>(async () => SAVED);
  installBridge({ saveAgentSecret });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  installBridge(undefined);
});

describe("pending secret request card", () => {
  it("shows the T3-style copy with plain-text instructions, a masked field and the TTL footnote", () => {
    render(workspace(<SecretRequestCard message={message(reference())} />));
    const card = screen.getByRole("region", { name: "Tailscale auth key" });
    expect(card).toHaveAttribute("data-secret-request-state", "pending");
    expect(card).toHaveClass("is-pending");
    expect(card).toHaveTextContent("Asking for a secret");
    expect(screen.getByRole("heading", { level: 3, name: "Tailscale auth key" })).toBeVisible();
    const description = card.querySelector(".secret-request-description")!;
    expect(description.textContent).toBe(reference().description);
    expect(card.querySelector("a")).toBeNull();
    expect(input()).toHaveAttribute("type", "password");
    expect(input()).toHaveAttribute("placeholder", "Paste the secret");
    expect(input()).toHaveAttribute("autocomplete", "off");
    expect(input()).toHaveAttribute("spellcheck", "false");
    expect(input()).toHaveAttribute("data-1p-ignore");
    expect(input()).toHaveAttribute("data-lpignore", "true");
    expect(screen.getByRole("button", { name: "Save securely" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(card).toHaveTextContent("Kept out of chat, in a private file this agent's commands can read for 24 hours");
    const order = [...card.querySelectorAll("input, button")].map((node) => node.getAttribute("aria-label") ?? node.getAttribute("name") ?? node.textContent);
    expect(order).toEqual(["agent-secret", "Show secret", "Save securely", "Decline"]);
  });

  it("follows the requested time to live in the footnote", () => {
    const { rerender } = render(workspace(<SecretRequestCard message={message(reference({ ttlHours: 1 }))} />));
    expect(screen.getByText("Kept out of chat, in a private file this agent's commands can read for 1 hour")).toBeVisible();
    rerender(workspace(<SecretRequestCard message={message(reference({ ttlHours: 6 }))} />));
    expect(screen.getByText("Kept out of chat, in a private file this agent's commands can read for 6 hours")).toBeVisible();
  });

  it("reveals and hides the value with a pressed toggle", () => {
    render(workspace(<SecretRequestCard message={message(reference())} />));
    const toggle = screen.getByRole("button", { name: "Show secret" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide secret" })).toHaveAttribute("aria-pressed", "true");
    expect(input()).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(input()).toHaveAttribute("type", "password");
  });

  it("saves through the desktop bridge only, clears the field and hands focus back to the composer", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: `  ${SECRET}  ` } });
    input().focus();
    await act(async () => {
      fireEvent.submit(input().closest("form")!);
    });
    const request = reference();
    expect(saveAgentSecret).toHaveBeenCalledOnce();
    expect(saveAgentSecret).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID, requestId: request.requestId, secret: SECRET });
    expect(onCommand).not.toHaveBeenCalled();
    expect(input().value).toBe("");
    expect(screen.getByLabelText("Message")).toHaveFocus();
    expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("submits with the Enter key and does nothing on Escape", async () => {
    const user = userEvent.setup();
    render(workspace(<SecretRequestCard message={message(reference())} />));
    await user.click(input());
    await user.keyboard(SECRET);
    await user.keyboard("{Escape}");
    expect(onCommand).not.toHaveBeenCalled();
    expect(input().value).toBe(SECRET);
    expect(screen.getByRole("region", { name: "Tailscale auth key" })).toHaveAttribute("data-secret-request-state", "pending");
    await user.keyboard("{Enter}");
    expect(saveAgentSecret).toHaveBeenCalledOnce();
    expect(saveAgentSecret.mock.calls[0]![0]).toMatchObject({ secret: SECRET });
  });

  it("sends a double submit once and shows Saving while busy", async () => {
    let resolve!: (result: SaveAgentSecretResult) => void;
    saveAgentSecret.mockImplementation(() => new Promise<SaveAgentSecretResult>((done) => { resolve = done; }));
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: SECRET } });
    const form = input().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(saveAgentSecret).toHaveBeenCalledOnce();
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => { resolve(SAVED); });
    expect(form).toHaveAttribute("aria-busy", "false");
  });

  it("keeps the value after a failure and shows only fixed copy", async () => {
    saveAgentSecret.mockRejectedValueOnce(new Error("Error invoking remote method 'inertia:save-agent-secret': Error: That secret request is no longer pending."));
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: SECRET } });
    await act(async () => { fireEvent.submit(input().closest("form")!); });
    expect(screen.getByRole("alert")).toHaveTextContent("That secret request is no longer pending.");
    expect(input().value).toBe(SECRET);
    expect(input()).toHaveAttribute("aria-invalid", "true");

    saveAgentSecret.mockRejectedValueOnce(new Error(`vault rejected ${SECRET}`));
    await act(async () => { fireEvent.submit(input().closest("form")!); });
    expect(screen.getByRole("alert")).toHaveTextContent("The secret could not be saved. Try again.");
    expect(screen.getByRole("alert").textContent).not.toContain(SECRET);
  });

  it("rejects a too-short value before it leaves the card", async () => {
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: "abc" } });
    await act(async () => { fireEvent.submit(input().closest("form")!); });
    expect(saveAgentSecret).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The secret must be at least 4 characters long.");
  });

  it("declines through the runtime command without any value", async () => {
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: SECRET } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Decline" })); });
    expect(onCommand).toHaveBeenCalledWith("secret-request.decline", {
      type: "secret-request.decline",
      payload: { conversationId: CONVERSATION_ID, requestId: reference().requestId },
    });
    expect(JSON.stringify(onCommand.mock.calls)).not.toContain(SECRET);
    expect(saveAgentSecret).not.toHaveBeenCalled();
  });

  it("focuses the field when it appears beside an idle empty composer, once per request", () => {
    const { unmount } = render(workspace(<SecretRequestCard message={message(reference())} />));
    expect(input()).toHaveFocus();
    unmount();
    render(workspace(<SecretRequestCard message={message(reference())} />));
    expect(input()).not.toHaveFocus();
  });

  it("leaves focus alone while the composer holds a draft or focus is elsewhere", () => {
    render(workspace(<SecretRequestCard message={message(reference())} />, { composer: "half-typed follow-up" }));
    expect(input()).not.toHaveFocus();
    requestCounter += 1;
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    render(workspace(<SecretRequestCard message={message(reference({ title: "Other key" }))} />));
    expect(screen.getByLabelText("Other key", { selector: "input" })).not.toHaveFocus();
    expect(other).toHaveFocus();
    other.remove();
  });

  it("answers from a detached chat window whose bridge exposes saveAgentSecret", async () => {
    installBridge({ getWindowContext: vi.fn(), openInMainWindow: vi.fn(), saveAgentSecret });
    render(workspace(<SecretRequestCard message={message(reference())} />));
    fireEvent.change(input(), { target: { value: SECRET } });
    await act(async () => { fireEvent.submit(input().closest("form")!); });
    expect(saveAgentSecret).toHaveBeenCalledOnce();
  });
});

describe("read-only secret request line", () => {
  it("shows a single quiet line when the window cannot answer", () => {
    installBridge({ getWindowContext: vi.fn() });
    render(workspace(<SecretRequestCard message={message(reference())} />));
    const card = screen.getByRole("region", { name: "Asking for a secret: Tailscale auth key" });
    expect(card).toHaveAttribute("data-secret-request-mode", "read-only");
    expect(card).toHaveTextContent("Tailscale auth key·Waiting for your answer in the main window");
    expect(card.querySelector("input, button")).toBeNull();
  });

  it("is read-only without a command runner", () => {
    render(workspace(<SecretRequestCard message={message(reference())} />, { runner: null }));
    expect(document.querySelector('input[name="agent-secret"]')).toBeNull();
    expect(screen.getByText("Waiting for your answer in the main window")).toBeVisible();
  });
});

describe("settled secret request rows", () => {
  it.each([
    ["declined", "Declined"],
    ["ended", "Request ended"],
    ["expired", "Expired"],
    ["revoked", "Revoked"],
  ] as const)("renders %s as one row", (status, copy) => {
    render(workspace(<SecretRequestCard message={message(settled(status))} />));
    const card = screen.getByRole("region", { name: "Asking for a secret: Tailscale auth key" });
    expect(card).toHaveAttribute("data-secret-request-state", status);
    expect(card).toHaveClass("is-settled");
    expect(card.querySelector(".secret-request-row-status")).toHaveTextContent(copy);
    expect(card.querySelector("input")).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/u })).toBeNull();
  });

  it("shows the expiry of a saved secret, refreshes it each minute and never the value", () => {
    vi.useFakeTimers({ now: NOW });
    render(workspace(<SecretRequestCard message={message(settled("saved"))} />));
    expect(screen.getByText("Saved · expires in 23h")).toBeVisible();
    act(() => { vi.setSystemTime(Date.parse("2026-10-30T11:20:00.000Z")); vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("Saved · expires in 39m")).toBeVisible();
  });

  it("says when a saved secret only lives until Inertia quits", () => {
    vi.useFakeTimers({ now: NOW });
    render(workspace(<SecretRequestCard message={message(settled("saved", { storage: "memory" }))} />));
    expect(screen.getByText("Saved · expires in 23h · kept until Inertia quits")).toBeVisible();
  });

  it("revokes a saved secret from its row", async () => {
    render(workspace(<SecretRequestCard message={message(settled("saved"))} />));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Revoke Tailscale auth key" })); });
    expect(onCommand).toHaveBeenCalledWith("secret-request.revoke", {
      type: "secret-request.revoke",
      payload: { requestId: reference().requestId },
    });
  });

  it("announces the transition in a polite live region", () => {
    const pending = reference();
    const { rerender } = render(workspace(<SecretRequestCard message={message(pending)} />));
    const live = screen.getByRole("region", { name: "Tailscale auth key" }).querySelector('[role="status"]')!;
    expect(live).toHaveTextContent("");
    rerender(workspace(<SecretRequestCard message={message(settled("saved"))} />));
    expect(live.isConnected).toBe(true);
    expect(live).toHaveTextContent("Secret saved");
    rerender(workspace(<SecretRequestCard message={message(settled("revoked"))} />));
    expect(live).toHaveTextContent("Secret revoked");
  });

  it("lists settled rows for a consolidated turn", () => {
    render(workspace(<SecretRequestList messages={[message(settled("declined"))]} />));
    expect(screen.getByRole("list", { name: "Secret requests" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
