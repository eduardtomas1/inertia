import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import type { SettingsSection } from "../../src/renderer/src/lib/settingsTarget";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

const removed: Record<string, { section: SettingsSection; anchor: string; gone: string[]; kept?: string[] }> = {
  appearance: {
    section: "appearance",
    anchor: "Interface scale",
    gone: [
      "Scales navigation, messages, controls, files and diffs. Terminal text stays independent.",
      "Spacing and type size of agent responses.",
    ],
  },
  chats: {
    section: "chats",
    anchor: "Show reasoning summaries",
    gone: [
      "Provider-supplied summaries, shown as they arrive.",
      "Final answers stay visible; successful tool activity is condensed.",
      "Each code block keeps its own wrap control.",
      "Opens the Plan panel when an agent publishes steps.",
      "Provider usage and context in the composer.",
      "Hide whitespace-only changes when supported.",
    ],
    kept: [
      "Ask before deleting chats or restoring checkpoints.",
      "Full access lets the agent act without asking. Choose it only for a workspace and task you trust.",
    ],
  },
  notifications: {
    section: "notifications",
    anchor: "Desktop notifications",
    gone: [
      "Completion and attention alerts, without prompt or response text.",
      "Skips desktop notifications while an Inertia window is in front.",
      "Shows a notice in Inertia when an account's remaining quota drops below the chosen level.",
      "The first notice appears at this level and again at each lower one.",
    ],
  },
  keyboard: {
    section: "keyboard",
    anchor: "Open settings",
    gone: [
      "⌘ stays fixed; available keys avoid system shortcuts.",
      "Also closes Settings. This shortcut is fixed.",
    ],
  },
  projects: {
    section: "projects",
    anchor: "Compact sidebar",
    gone: [
      "Uses Git identity and normalized paths, never display names.",
      "Less spacing in project navigation.",
    ],
  },
};

describe("settings helper copy", () => {
  it.each(Object.entries(removed))("keeps only consequence sentences in %s", async (_, { section, anchor, gone, kept = [] }) => {
    render(<SettingsView {...settingsViewProps({ target: { section } })} />);
    expect(await screen.findByText(anchor, { exact: true })).toBeVisible();
    for (const text of gone) expect(screen.queryByText(text, { exact: true }), text).toBeNull();
    for (const text of kept) expect(screen.getByText(text, { exact: true })).toBeVisible();
  });
});

describe("agents helper copy", () => {
  it("keeps the credential note and one-line empty states", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "agents" }, providers: [settingsProvider("codex", "Codex")] })} />);
    expect(await screen.findByText("Sign-in stays in the provider's own flow. Inertia stores no provider passwords or tokens.")).toBeVisible();
    for (const text of [
      "Use the coding tools and accounts already installed on this computer.",
      "Shown wherever Inertia names this account.",
      "Found automatically. A file you choose is version-checked before it is saved.",
      "Route chats through your own compatible endpoint.",
    ]) expect(screen.queryByText(text)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Models/u }));
    expect(screen.getByText("No models reported yet.", { exact: true })).toBeVisible();
  });
});
