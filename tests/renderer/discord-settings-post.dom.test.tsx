import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscordSettings } from "../../src/renderer/src/components/DiscordSettings";

const SAVED = "https://github.com/org/old-repo";

afterEach(() => { Reflect.deleteProperty(window, "inertia"); });

function setup(repositoryUrl = SAVED) {
  const send = vi.fn(async () => ({ sent: true, comparisonLimited: false }));
  const state = { profileId: "discord-release-webhook", hasSecret: true, storage: { available: true, provider: "keychain", message: null }, diagnosticId: null };
  const setBackendCredential = vi.fn(async () => state);
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    getBackendCredentialState: vi.fn(async () => state),
    setBackendCredential,
    reportValidationDiagnostic: vi.fn(async () => null),
    queryDiagnostics: vi.fn(async () => ({ capture: true })),
    sendDiscordReleaseInfo: send,
  } });
  render(<DiscordSettings disabled={false} repositoryUrl={repositoryUrl} onUpdate={vi.fn(async () => undefined)} />);
  return { send, setBackendCredential };
}

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

describe("Discord release post", () => {
  it("refuses to post while the repository field holds an invalid draft and says why", async () => {
    const { send } = setup();
    await act(async () => { await Promise.resolve(); });
    const field = screen.getByRole("textbox", { name: "Repository URL" });
    fireEvent.change(field, { target: { value: "github.com/org/new-repo" } });
    fireEvent.blur(field);

    fireEvent.click(screen.getByRole("button", { name: "Post release to Discord…" }));

    expect(screen.queryByRole("group", { name: "Confirm Discord post" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Fix the repository URL before posting.");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to post a repository that has not been saved yet", async () => {
    const { send } = setup();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole("textbox", { name: "Repository URL" }), { target: { value: "https://gitlab.com/org/new-repo" } });

    fireEvent.click(screen.getByRole("button", { name: "Post release to Discord…" }));

    expect(screen.queryByRole("group", { name: "Confirm Discord post" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Save the repository URL before posting.");
    expect(send).not.toHaveBeenCalled();
  });

  it("names the saved repository in the confirmation and posts that repository", async () => {
    const { send } = setup();
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: "Post release to Discord…" }));
    const confirmation = screen.getByRole("group", { name: "Confirm Discord post" });
    expect(confirmation).toHaveTextContent(`Post the latest release of ${SAVED} to Discord?`);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Post to Discord" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(send).toHaveBeenCalledExactlyOnceWith({ repositoryUrl: SAVED });
  });

  it("reports a saved webhook in the webhook row, not under the post action", async () => {
    setup();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://discord.com/api/webhooks/1/abc" } });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save webhook" })); });

    expect(within(row("discord-webhook")).getByText("Discord webhook saved securely.")).toBeInTheDocument();
    expect(document.querySelector(".release-info-status")).not.toHaveTextContent("Discord webhook saved securely.");
  });
});
