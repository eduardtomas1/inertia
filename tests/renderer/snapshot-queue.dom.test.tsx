import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";
import { useSnapshotQueue } from "../../src/renderer/src/hooks/useSnapshotQueue";

const original = window.inertia;
const listeners = new Set<(event: SnapshotDelivery) => void>();
afterEach(() => { cleanup(); listeners.clear(); window.inertia = original; });

function fixture(hasChat = false) {
  const errors: unknown[] = [];
  const onError = (event: Event): void => { errors.push((event as CustomEvent<unknown>).detail); };
  window.addEventListener("inertia:snapshot-error", onError);
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null }));
  window.inertia = { ...original, snapshot, cancelAttachmentImport: vi.fn(async () => undefined),
    onSnapshot: (callback) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  const onNotice = vi.fn();
  const showChat = vi.fn();
  const startChat = vi.fn();
  function Pane({ id }: { id: string }) {
    const textarea = useRef<HTMLTextAreaElement>(null);
    useComposerSnapshots(id, async () => "adopted", textarea);
    return <div className="conversation-pane-chat"><textarea ref={textarea} aria-label={`Message ${id}`} /></div>;
  }
  function Workbench({ chat }: { chat: string | null }) {
    useSnapshotQueue(onNotice, { hasChat, show: showChat, start: startChat });
    return chat ? <Pane id={chat} /> : <p>Settings</p>;
  }
  const view = render(<Workbench chat={null} />);
  return {
    errors, snapshot, onNotice, showChat, startChat, view, Workbench,
    emit: (event: SnapshotDelivery) => { act(() => { for (const listener of listeners) listener(event); }); },
    cleanup: () => window.removeEventListener("inertia:snapshot-error", onError),
  };
}

it("shows a snapshot notice through the workbench notice", () => {
  const value = fixture();
  value.emit({ notice: "A snapshot is already being captured. Try again when it finishes." });
  expect(value.onNotice).toHaveBeenCalledExactlyOnceWith("A snapshot is already being captured. Try again when it finishes.");
  expect(value.showChat).not.toHaveBeenCalled();
  value.cleanup();
});

it("starts a chat for a queued snapshot when no chat or draft exists", () => {
  const value = fixture();
  value.emit({ pending: true });
  expect(value.startChat).toHaveBeenCalledOnce();
  expect(value.showChat).not.toHaveBeenCalled();
  expect(value.snapshot).not.toHaveBeenCalled();
  value.cleanup();
});

it("returns to the existing chat or new-chat draft instead of starting another chat", () => {
  const value = fixture(true);
  value.emit({ pending: true });
  expect(value.showChat).toHaveBeenCalledOnce();
  expect(value.startChat).not.toHaveBeenCalled();
  value.cleanup();
});

it("binds the mounted message box for a queued snapshot instead of opening another chat", async () => {
  const value = fixture();
  value.view.rerender(<value.Workbench chat="11111111-1111-4111-8111-111111111111" />);
  value.snapshot.mockClear();
  value.emit({ pending: true });
  expect(value.showChat).not.toHaveBeenCalled();
  expect(value.startChat).not.toHaveBeenCalled();
  expect(value.snapshot).toHaveBeenCalledExactlyOnceWith({ type: "bind", conversationId: "11111111-1111-4111-8111-111111111111" });
  value.cleanup();
});

it("keeps notices and queue signals out of the chat's snapshot dialog", () => {
  const value = fixture();
  value.view.rerender(<value.Workbench chat="11111111-1111-4111-8111-111111111111" />);
  value.emit({ notice: "Snapshot not taken." });
  value.emit({ pending: true });
  expect(value.errors).toEqual([]);
  value.cleanup();
});
