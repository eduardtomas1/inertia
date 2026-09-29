import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ConversationShell } from "../../src/shared/contracts";
import { DEFAULT_COMPLETION_SOUND, type CompletionSoundSettings } from "../../src/shared/completion-sound";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const player = vi.hoisted(() => ({
  playCompletionSound: vi.fn(async () => true),
  decodeCustomCompletionSound: vi.fn(async () => ({ duration: 1.4 }) as AudioBuffer | null),
  forgetCustomCompletionSound: vi.fn(),
}));

vi.mock("../../src/renderer/src/utils/completionSoundPlayer", () => player);

const { completedTurnDurationMs, useCompletionSounds } = await import("../../src/renderer/src/hooks/useCompletionSounds");
const { CompletionSoundSettings: SoundSettings } = await import("../../src/renderer/src/components/notifications/CompletionSoundSettings");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
  vi.useRealTimers();
});

function thread(
  id: string,
  status: ConversationShell["status"],
  turn: { startedAt: string; completedAt: string | null } | null = null,
  extra: Partial<ConversationShell> = {},
): ConversationShell {
  return {
    id,
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Thread",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status,
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: turn?.completedAt ?? null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-09-28T09:00:00.000Z",
    updatedAt: "2026-09-28T09:00:00.000Z",
    latestTurn: turn ? { requestedAt: turn.startedAt, ...turn } as ConversationShell["latestTurn"] : null,
    pendingApproval: false,
    pendingInput: false,
    ...extra,
  };
}

const snapshot = (...conversations: ConversationShell[]): AppSnapshot => ({ conversations } as AppSnapshot);

function Watcher({ value, settings, play }: { value: AppSnapshot; settings: CompletionSoundSettings; play: () => void }): null {
  useCompletionSounds(value, settings, play);
  return null;
}

const enabled = { ...DEFAULT_COMPLETION_SOUND, enabled: true };
const start = "2026-09-28T09:00:00.000Z";

describe("completion sound watcher", () => {
  it("rings once per finished batch and never for the snapshot it starts from", () => {
    const play = vi.fn();
    const view = render(<Watcher value={snapshot(thread("a", "completed", { startedAt: start, completedAt: "2026-09-28T09:00:05.000Z" }))} settings={enabled} play={play} />);
    expect(play).not.toHaveBeenCalled();

    view.rerender(<Watcher value={snapshot(thread("a", "running"), thread("b", "running"))} settings={enabled} play={play} />);
    expect(play).not.toHaveBeenCalled();
    view.rerender(<Watcher value={snapshot(
      thread("a", "completed", { startedAt: start, completedAt: "2026-09-28T09:00:05.000Z" }),
      thread("b", "failed", { startedAt: start, completedAt: "2026-09-28T09:00:06.000Z" }),
    )} settings={enabled} play={play} />);
    expect(play).toHaveBeenCalledExactlyOnceWith(enabled);

    view.rerender(<Watcher value={snapshot(
      thread("a", "needs-input"),
      thread("b", "failed", { startedAt: start, completedAt: "2026-09-28T09:00:06.000Z" }),
    )} settings={enabled} play={play} />);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for quick tasks when only long tasks should ring", () => {
    const play = vi.fn();
    const longOnly = { ...enabled, longRunsOnly: true, longRunSeconds: 120 };
    const view = render(<Watcher value={snapshot(thread("a", "running"), thread("b", "running"))} settings={longOnly} play={play} />);
    view.rerender(<Watcher value={snapshot(
      thread("a", "completed", { startedAt: start, completedAt: "2026-09-28T09:01:59.000Z" }),
      thread("b", "running"),
    )} settings={longOnly} play={play} />);
    expect(play).not.toHaveBeenCalled();
    view.rerender(<Watcher value={snapshot(
      thread("a", "completed", { startedAt: start, completedAt: "2026-09-28T09:01:59.000Z" }),
      thread("b", "completed", { startedAt: start, completedAt: "2026-09-28T09:02:00.000Z" }),
    )} settings={longOnly} play={play} />);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("skips snoozed chats and measures turns it watched when timing evidence is missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T09:00:00.000Z"));
    const play = vi.fn();
    const longOnly = { ...enabled, longRunsOnly: true, longRunSeconds: 60 };
    const view = render(<Watcher value={snapshot(thread("a", "running"), thread("z", "running", null, { snoozedUntil: "2026-09-29T00:00:00.000Z" }))} settings={longOnly} play={play} />);
    view.rerender(<Watcher value={snapshot(thread("a", "running"), thread("z", "completed", { startedAt: start, completedAt: "2026-09-28T09:30:00.000Z" }, { snoozedUntil: "2026-09-29T00:00:00.000Z" }))} settings={longOnly} play={play} />);
    expect(play).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-09-28T09:02:00.000Z"));
    view.rerender(<Watcher value={snapshot(thread("a", "completed"))} settings={longOnly} play={play} />);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("derives the duration from the finished turn", () => {
    expect(completedTurnDurationMs(thread("a", "completed", { startedAt: start, completedAt: "2026-09-28T09:05:00.000Z" }))).toBe(300_000);
    expect(completedTurnDurationMs(thread("a", "completed"))).toBeNull();
    expect(completedTurnDurationMs(thread("a", "completed", { startedAt: "2026-09-28T09:06:00.000Z", completedAt: "2026-09-28T09:05:00.000Z" }))).toBeNull();
  });
});

describe("completion sound settings", () => {
  const ding = { file: "0123456789abcdef.wav", name: "Ding" } as const;
  const rain = { file: "fedcba9876543210.mp3", name: "Rain" } as const;

  function renderSettings(settings: CompletionSoundSettings, bridge: Record<string, unknown> = {}) {
    Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
    const onUpdate = vi.fn(async () => undefined);
    const view = render(<SoundSettings settings={settings} disabled={false} onUpdate={onUpdate} />);
    return { ...view, onUpdate };
  }

  it("turns on with a preview and reveals the sound choices", () => {
    const { onUpdate, rerender } = renderSettings(DEFAULT_COMPLETION_SOUND);
    expect(screen.queryByRole("radiogroup", { name: "Sound" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Sound when a task ends" }));
    expect(onUpdate).toHaveBeenCalledWith({ completionSound: enabled });
    expect(player.playCompletionSound).toHaveBeenCalledWith({ sound: "chime", library: [] });
    rerender(<SoundSettings settings={enabled} disabled={false} onUpdate={onUpdate} />);
    const group = screen.getByRole("radiogroup", { name: "Sound" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(6);
    expect(screen.getByRole("radio", { name: /Chime/u })).toHaveAttribute("aria-checked", "true");
  });

  it("previews each sound as the keyboard moves through the choices", () => {
    const { onUpdate } = renderSettings(enabled);
    const chime = screen.getByRole("radio", { name: /Chime/u });
    chime.focus();
    fireEvent.keyDown(chime, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /Glass/u })).toHaveFocus();
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, sound: "glass" } });
    expect(player.playCompletionSound).toHaveBeenLastCalledWith({ sound: "glass", library: [] });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(player.playCompletionSound).toHaveBeenLastCalledWith({ sound: "glass", library: [] });
  });

  it("adds imported sounds to the library, selects the new one and asks for its name", async () => {
    player.decodeCustomCompletionSound.mockResolvedValueOnce({ duration: 4.2 } as AudioBuffer);
    const importCompletionSound = vi.fn(async () => ({ status: "imported", sound: rain }));
    const { onUpdate, rerender } = renderSettings({ ...enabled, library: [ding] }, {
      importCompletionSound,
      removeCompletionSound: vi.fn(async () => undefined),
    });
    fireEvent.click(screen.getByRole("button", { name: "Import sound…" }));
    const next = { ...enabled, sound: rain.file, library: [ding, rain] };
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ completionSound: next }));
    expect(importCompletionSound).toHaveBeenCalledWith([ding.file]);
    expect(player.playCompletionSound).toHaveBeenLastCalledWith({ sound: rain.file, library: [ding, rain] });
    expect(screen.getByRole("status")).toHaveTextContent("only the first 3 seconds will play");
    const name = screen.getByRole("textbox", { name: "Name for Rain" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "  Soft   rain " } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...next, library: [ding, { ...rain, name: "Soft rain" }] } });
    rerender(<SoundSettings settings={{ ...next, library: [ding, { ...rain, name: "Soft rain" }] }} disabled={false} onUpdate={onUpdate} />);
    expect(screen.getByRole("radio", { name: /Soft rain/u })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("radio")).toHaveLength(8);
  });

  it("renames on blur, reverts on Escape and previews one sound from the list", () => {
    const { onUpdate } = renderSettings({ ...enabled, library: [ding, rain] }, { importCompletionSound: vi.fn() });
    const name = screen.getByRole("textbox", { name: "Name for Ding" });
    fireEvent.change(name, { target: { value: "Door" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(name).toHaveValue("Ding");
    fireEvent.blur(name);
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Door" } });
    fireEvent.blur(name);
    expect(onUpdate).toHaveBeenCalledWith({ completionSound: { ...enabled, library: [{ ...ding, name: "Door" }, rain] } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Rain" }));
    expect(player.playCompletionSound).toHaveBeenLastCalledWith({ sound: rain.file, library: [{ ...ding, name: "Door" }, rain] });
  });

  it("explains rejected, duplicate or unplayable files and keeps the previous choice", async () => {
    const removeCompletionSound = vi.fn(async () => undefined);
    const importCompletionSound = vi.fn()
      .mockResolvedValueOnce({ status: "rejected", message: "That file is not a valid MP3 audio file." })
      .mockResolvedValueOnce({ status: "imported", sound: { file: "1111111111111111.mp3", name: "Broken" } })
      .mockResolvedValueOnce({ status: "imported", sound: { ...ding, name: "Ding copy" } })
      .mockResolvedValueOnce({ status: "cancelled" });
    const { onUpdate } = renderSettings({ ...enabled, library: [ding] }, { importCompletionSound, removeCompletionSound });
    const importButton = screen.getByRole("button", { name: "Import sound…" });
    fireEvent.click(importButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("not a valid MP3");

    player.decodeCustomCompletionSound.mockResolvedValueOnce(null);
    fireEvent.click(importButton);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be played"));
    expect(removeCompletionSound).toHaveBeenCalledExactlyOnceWith("1111111111111111.mp3");
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.click(importButton);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("already in your sounds as “Ding”"));
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, sound: ding.file, library: [ding] } });

    fireEvent.click(importButton);
    await waitFor(() => expect(importCompletionSound).toHaveBeenCalledTimes(4));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("removes one sound and falls back to Chime only when it was selected", async () => {
    const removeCompletionSound = vi.fn(async () => undefined);
    const { onUpdate } = renderSettings({ ...enabled, sound: rain.file, library: [ding, rain] }, {
      importCompletionSound: vi.fn(),
      removeCompletionSound,
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Ding" })); });
    expect(removeCompletionSound).toHaveBeenCalledExactlyOnceWith(ding.file);
    expect(player.forgetCustomCompletionSound).toHaveBeenCalledWith(ding.file);
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, sound: rain.file, library: [rain] } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Rain" })); });
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, sound: "chime", library: [] } });
  });

  it("deletes a removed sound's file only after the removal is saved", async () => {
    const removeCompletionSound = vi.fn(async () => undefined);
    const { onUpdate } = renderSettings({ ...enabled, sound: ding.file, library: [ding, rain] }, {
      importCompletionSound: vi.fn(),
      removeCompletionSound,
    });
    let save!: () => void;
    onUpdate.mockImplementationOnce(() => new Promise<undefined>((resolve) => { save = () => resolve(undefined); }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Ding" })); });
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, sound: "chime", library: [rain] } });
    expect(removeCompletionSound).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import sound…" })).toBeDisabled();
    await act(async () => { save(); });
    expect(removeCompletionSound).toHaveBeenCalledExactlyOnceWith(ding.file);
    expect(screen.getByRole("button", { name: "Import sound…" })).toBeEnabled();
  });

  it("keeps the file and its reference when the removal cannot be saved", async () => {
    const removeCompletionSound = vi.fn(async () => undefined);
    const { onUpdate } = renderSettings({ ...enabled, sound: ding.file, library: [ding, rain] }, {
      importCompletionSound: vi.fn(),
      removeCompletionSound,
    });
    onUpdate.mockRejectedValueOnce(new Error("The local service disconnected."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Ding" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(removeCompletionSound).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name for Ding" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ding/u })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Import sound…" })).toBeEnabled();
  });

  it("leaves an import whose save failed out of the library so the next import prunes it", async () => {
    const removeCompletionSound = vi.fn(async () => undefined);
    const importCompletionSound = vi.fn()
      .mockResolvedValueOnce({ status: "imported", sound: rain })
      .mockResolvedValueOnce({ status: "cancelled" });
    const { onUpdate } = renderSettings({ ...enabled, library: [ding] }, { importCompletionSound, removeCompletionSound });
    onUpdate.mockRejectedValueOnce(new Error("The local service disconnected."));
    fireEvent.click(screen.getByRole("button", { name: "Import sound…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.queryByRole("textbox", { name: "Name for Rain" })).not.toBeInTheDocument();
    expect(removeCompletionSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import sound…" }));
    await waitFor(() => expect(importCompletionSound).toHaveBeenCalledTimes(2));
    expect(importCompletionSound).toHaveBeenLastCalledWith([ding.file]);
  });

  it("stops importing at eight sounds", () => {
    const library = Array.from({ length: 8 }, (_, index) => ({ file: `${index.toString(16).padStart(16, "0")}.wav` as const, name: `Clip ${index}` }));
    renderSettings({ ...enabled, library }, { importCompletionSound: vi.fn() });
    expect(screen.getByRole("button", { name: "Import sound…" })).toBeDisabled();
    expect(screen.getByText(/You can keep up to 8 sounds/u)).toBeInTheDocument();
  });

  it("chooses how long a task must run before it rings", () => {
    const { onUpdate, rerender } = renderSettings(enabled);
    expect(screen.queryByRole("radiogroup", { name: "Long task duration" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Only after long tasks" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, longRunsOnly: true } });
    rerender(<SoundSettings settings={{ ...enabled, longRunsOnly: true }} disabled={false} onUpdate={onUpdate} />);
    const labels = [...screen.getByRole("radiogroup", { name: "Long task duration" }).querySelectorAll('[role="radio"]')].map((radio) => radio.textContent);
    expect(labels).toEqual(["30 s", "1 min", "2 min", "5 min", "10 min", "15 min"]);
    expect(screen.getByRole("radio", { name: "1 min" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "5 min" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ completionSound: { ...enabled, longRunsOnly: true, longRunSeconds: 300 } });
  });

  it("hides the library where the desktop bridge is unavailable", () => {
    renderSettings(enabled);
    expect(screen.queryByRole("button", { name: "Import sound…" })).not.toBeInTheDocument();
  });
});
