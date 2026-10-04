import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { settingsSaveActions } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import { useAppRuntimeActions } from "../../src/renderer/src/hooks/useAppRuntimeActions";
import { useBackendProfiles } from "../../src/renderer/src/hooks/useBackendProfiles";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { defaultSettings } from "../../src/shared/contracts";
import { settingsViewProps } from "./settings-view-fixtures";

function deferredSave(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function settingRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  if (!row) throw new Error(`Missing setting row ${id}`);
  return row;
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
      setBackendCredential: vi.fn(),
      clearBackendCredential: vi.fn(),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings saving", () => {
  it("keeps every typed character of the Discord repository URL and saves only a valid URL on blur", async () => {
    const save = deferredSave();
    const onUpdate = vi.fn(() => save.promise);
    render(<SettingsView {...settingsViewProps({ onUpdate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Devices & integrations" }));
    const repository = await screen.findByLabelText("Repository URL");

    let typed = "";
    for (const character of "not a url") {
      typed += character;
      fireEvent.change(repository, { target: { value: typed } });
    }
    expect(repository).toHaveValue("not a url");
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.blur(repository);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(repository).toHaveAttribute("aria-invalid", "true");
    expect(repository).toHaveAccessibleDescription("Use an HTTPS GitHub or GitLab repository URL.");

    fireEvent.change(repository, { target: { value: "https://github.com/eduardtomas1/inertia" } });
    expect(repository).not.toHaveAttribute("aria-invalid");
    fireEvent.keyDown(repository, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      discordReleaseRepositoryUrl: "https://github.com/eduardtomas1/inertia",
    });
    expect(repository).toHaveValue("https://github.com/eduardtomas1/inertia");
    await act(async () => save.resolve());
    expect(repository).toHaveValue("https://github.com/eduardtomas1/inertia");
  });

  it("drags the terminal font size locally and saves once when the slider is released", async () => {
    const save = deferredSave();
    const onUpdate = vi.fn(() => save.promise);
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate })} />);
    const slider = screen.getByRole("slider", { name: "Terminal font size" });

    for (const value of ["14", "15", "16"]) fireEvent.input(slider, { target: { value } });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("16px")).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "16" } });
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ terminalFontSize: 16 });
    expect(slider).toHaveValue("16");
    await act(async () => save.resolve());
    expect(slider).toHaveValue("16");
    expect(screen.getByText("16px")).toBeInTheDocument();
  });

  it("returns the terminal font size to the saved value when the save fails", async () => {
    const save = deferredSave();
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate: () => save.promise })} />);
    const slider = screen.getByRole("slider", { name: "Terminal font size" });
    fireEvent.change(slider, { target: { value: "18" } });
    await act(async () => save.reject(new Error("offline")));
    expect(slider).toHaveValue(String(defaultSettings.terminalFontSize));
    expect(within(settingRow("terminal-font-size")).getByRole("alert"))
      .toHaveTextContent("Couldn't save. Try again.");
  });

  it("shows a failed switch save in its own row instead of swallowing it", async () => {
    const save = deferredSave();
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, onUpdate: () => save.promise })} />);
    const timestamps = screen.getByRole("switch", { name: "Message timestamps" });

    fireEvent.click(timestamps);
    expect(timestamps).not.toBeChecked();
    await act(async () => save.reject(new Error("offline")));

    expect(timestamps).toBeChecked();
    expect(within(settingRow("message-timestamps")).getByRole("alert"))
      .toHaveTextContent("Couldn't save. Try again.");
  });

  it("reports a failed settings save only in its row, not as an app error", async () => {
    const setActionError = vi.fn();
    const { result } = renderHook(() => useAppRuntimeActions({
      sendCommand: vi.fn().mockRejectedValue(new Error("The local service disconnected.")),
      refreshDetail: vi.fn(), setActionError, setBusyAction: vi.fn(),
    }));
    render(<SettingsView {...settingsViewProps({ target: { section: "chats" }, ...settingsSaveActions(result.current.run) })} />);
    fireEvent.click(screen.getByRole("switch", { name: "Message timestamps" }));
    await waitFor(() => expect(within(settingRow("message-timestamps")).getByRole("alert"))
      .toHaveTextContent("Couldn't save. Try again."));
    expect(setActionError.mock.calls).toEqual([[null]]);
  });

  it("sends every settings save without the app error report", async () => {
    const run = vi.fn(async () => ({ type: "request.ok" as const, requestId: "settings" }));
    const actions = settingsSaveActions(run);
    await actions.onUpdate({ showTimestamps: false });
    await actions.onSetDefaultModel({ defaultProvider: "codex", defaultModel: "", defaultReasoningEffort: "" });
    await actions.onRestoreDefaults();
    expect(run.mock.calls).toEqual([
      ["settings.update", { type: "settings.update", payload: { showTimestamps: false } }, { reportError: false }],
      ["settings.default-model.set", { type: "settings.default-model.set", payload: { defaultProvider: "codex", defaultModel: "", defaultReasoningEffort: "" } }, { reportError: false }],
      ["settings.restore-defaults", { type: "settings.restore-defaults", payload: {} }, { reportError: false }],
    ]);
  });

  it("sets the new chat backend default without the app error report", async () => {
    const run = vi.fn(async () => ({ type: "request.ok" as const, requestId: "settings" }));
    const { result } = renderHook(() => useBackendProfiles({ request: vi.fn(), run }));
    await result.current.setBackendDefault(null, providerNativeModelSelection({ providerId: "codex" }));
    expect(run).toHaveBeenCalledExactlyOnceWith("backend.default.set", expect.objectContaining({ type: "backend.default.set" }), { reportError: false });
  });

  it("confirms a successful radio save in its row", async () => {
    render(<SettingsView {...settingsViewProps()} />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Interface scale" }))
      .getByRole("radio", { name: "Large" }));
    await waitFor(() => expect(within(settingRow("interface-scale")).getByRole("status"))
      .toHaveTextContent("Saved"));
  });
});
