import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppView } from "../../src/renderer/src/appView";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { useSettingsMode } from "../../src/renderer/src/hooks/useSettingsMode";
import { conversation } from "./composer-fixtures";
import { settingsViewProps } from "./settings-view-fixtures";

type SettingsOverrides = Parameters<typeof settingsViewProps>[0];

function Harness({ initialView = "workspace", overrides }: { initialView?: AppView; overrides?: SettingsOverrides }): React.JSX.Element {
  const [view, setView] = useState<AppView>(initialView);
  const [transientOpener, setTransientOpener] = useState(true);
  const mode = useSettingsMode({ view, navigateToView: setView });
  return (
    <>
      <section id="main-workspace" tabIndex={-1} aria-label="Main workspace">
        {view === "settings" ? (
          <SettingsView
            {...settingsViewProps(overrides)}
            target={mode.settingsTarget}
            initialSection={mode.lastSection}
            onSectionChange={mode.rememberSection}
          />
        ) : view === "workspace" ? (
          <section aria-label="Message composer"><textarea aria-label="Message" /></section>
        ) : <p>Usage</p>}
        {view === "settings" && <div role="menu" aria-label="Open menu"><button type="button" role="menuitem">Menu item</button></div>}
      </section>
      <button type="button" onClick={() => mode.openSettings()}>Open settings</button>
      <button type="button" onClick={() => mode.toggleSettings()}>Toggle settings</button>
      {transientOpener && view !== "settings" && (
        <button type="button" onClick={() => { setTransientOpener(false); mode.openSettings(); }}>Palette item</button>
      )}
      <output aria-label="Current view">{view}</output>
    </>
  );
}

function openFrom(name: string): HTMLElement {
  const opener = screen.getByRole("button", { name });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

function pressEscape(target: Element = document.activeElement ?? document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getPlatform: () => "darwin",
      getBackendCredentialState: vi.fn(async () => ({
        profileId: "discord-release-webhook",
        hasSecret: false,
        maskedValue: null,
        credentialGeneration: null,
        storage: { available: true, provider: "keychain" as const, message: null },
      })),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings as a mode", () => {
  it("leaves Settings with Escape and returns focus to the opener", async () => {
    render(<Harness />);
    const opener = openFrom("Open settings");
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");

    pressEscape();
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("returns to the view that was showing before Settings opened", () => {
    render(<Harness initialView="usage" />);
    openFrom("Open settings");
    pressEscape();
    expect(screen.getByLabelText("Current view")).toHaveTextContent("usage");
  });

  it("focuses the composer when the opener is gone and a chat is shown again", async () => {
    render(<Harness />);
    openFrom("Palette item");
    expect(screen.queryByRole("button", { name: "Palette item" })).not.toBeInTheDocument();
    pressEscape();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
  });

  it("focuses the main region when the opener is gone and no chat is shown", async () => {
    render(<Harness initialView="usage" />);
    openFrom("Palette item");
    pressEscape();
    await waitFor(() => expect(screen.getByRole("region", { name: "Main workspace" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("leaves Settings with Escape from a closed select", () => {
    render(<Harness />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
    pressEscape(screen.getByLabelText("Search everything key"));
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
  });

  it("keeps Escape for open menus and modal dialogs", () => {
    render(<Harness />);
    openFrom("Open settings");
    pressEscape(screen.getByRole("menuitem", { name: "Menu item" }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    try {
      pressEscape(screen.getByRole("main", { name: "Settings" }));
    } finally {
      dialog.remove();
    }
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
  });

  it("reverts an unsaved text field on the first Escape and leaves on the second", async () => {
    render(<Harness />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Devices & integrations" }));
    const repository = await screen.findByLabelText("Repository URL");
    repository.focus();
    fireEvent.change(repository, { target: { value: "not a url" } });
    fireEvent.blur(repository);
    expect(repository).toHaveAttribute("aria-invalid", "true");
    repository.focus();

    const first = pressEscape(repository);
    expect(first.defaultPrevented).toBe(true);
    expect(repository).toHaveValue("");
    expect(repository).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");

    pressEscape(repository);
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
  });

  it("leaves on the first Escape when the text field matches the saved value", async () => {
    render(<Harness />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Devices & integrations" }));
    const repository = await screen.findByLabelText("Repository URL");
    repository.focus();
    fireEvent.change(repository, { target: { value: " " } });
    pressEscape(repository);
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
  });

  it("keeps an unsent issue report: Escape in its text releases the field and only the next Escape leaves", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: new Proxy({ getPlatform: () => "darwin" } as Record<string, unknown>, {
        get: (target, key: string) => key in target ? target[key] : key === "then" ? undefined
          : key.startsWith("on") ? vi.fn(() => () => undefined) : vi.fn(async () => null),
      }),
    });
    const onReportCommand = vi.fn(async () => ({
      type: "request.result" as const,
      requestId: "request",
      result: { kind: "support.report" as const, report: null },
    }));
    render(<Harness overrides={{ onReportCommand: onReportCommand as never }} />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Help" })).toHaveFocus());
    const description = await screen.findByRole("textbox", { name: "What happened" });
    await waitFor(() => expect(description).toBeEnabled());
    fireEvent.change(description, { target: { value: "Typed for five minutes before pressing Escape" } });
    description.focus();

    const first = pressEscape(description);
    expect(first.defaultPrevented).toBe(true);
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
    expect(description).toHaveValue("Typed for five minutes before pressing Escape");
    expect(description).not.toHaveFocus();

    pressEscape();
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
  });

  it("clears the archived chats filter with Escape before leaving", async () => {
    const archived = { ...conversation("33333333-3333-4333-8333-333333333333"), title: "Old investigation", archivedAt: "2026-09-01T00:00:00.000Z" };
    render(<Harness overrides={{ archived: [archived] }} />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Data" })).toHaveFocus());
    const filter = await screen.findByRole("searchbox", { name: "Filter archived chats" });
    filter.focus();
    fireEvent.change(filter, { target: { value: "zebra" } });
    expect(screen.getByText("No archived chats match this filter.")).toBeInTheDocument();

    const first = pressEscape(filter);
    expect(first.defaultPrevented).toBe(true);
    expect(filter).toHaveValue("");
    expect(filter).toHaveFocus();
    expect(screen.getByText("Old investigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
  });

  it("saves a valid draft in the focused field when Settings is closed without leaving the field", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<Harness overrides={{ onUpdate }} />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Devices & integrations" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Devices & integrations" })).toHaveFocus());
    const repository = await screen.findByLabelText("Repository URL");
    repository.focus();
    fireEvent.change(repository, { target: { value: "https://gitlab.com/acme/widgets" } });

    fireEvent.click(screen.getByRole("button", { name: "Toggle settings" }));

    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
    expect(onUpdate).toHaveBeenCalledWith({ discordReleaseRepositoryUrl: "https://gitlab.com/acme/widgets" });
  });

  it("remembers the last section when Settings opens again and moves focus to the section title", async () => {
    render(<Harness />);
    openFrom("Open settings");
    fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Keyboard" })).toHaveFocus());
    pressEscape();

    openFrom("Open settings");
    expect(screen.getByRole("button", { name: "Keyboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main", { name: "Settings" })).toHaveFocus();
  });

  it("toggles Settings open and closed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle settings" }));
    expect(screen.getByLabelText("Current view")).toHaveTextContent("settings");
    fireEvent.click(screen.getByRole("button", { name: "Toggle settings" }));
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
  });
});
