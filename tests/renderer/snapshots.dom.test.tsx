import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";
import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import { ContextCompactionRow } from "../../src/renderer/src/components/response-timeline/ContextCompactionRow";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const original = window.inertia;
afterEach(() => { window.inertia = original; });

it("routes a delivered snapshot only to its captured conversation and cancels stale leases", async () => {
  let listener!: (value: SnapshotDelivery) => void;
  const cancel = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const adopt = vi.fn(async () => undefined);
  window.inertia = { ...original, snapshot: vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null })), onSnapshot: (fn) => { listener = fn; return () => undefined; }, cancelAttachmentImport: cancel, commitAttachmentImport: commit };
  const hook = renderHook(({ id }) => useComposerSnapshots(id, adopt, useRef<HTMLTextAreaElement>(null)), { initialProps: { id: "chat-a" } });
  const selection = { batchId: "capture-1", attachments: [{ id: "shot", path: "shot", name: "shot.png", mimeType: "image/png" as const, size: 10, snapshot: snapshotFixture() }] };
  act(() => listener({ conversationId: "chat-a", selection }));
  await waitFor(() => expect(adopt).toHaveBeenCalledOnce());
  hook.rerender({ id: "chat-b" });
  act(() => listener({ conversationId: "chat-a", selection: { ...selection, batchId: "capture-2" } }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("capture-2"));
  expect(adopt).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled();
});

it("shows app and window identity on a removable snapshot attachment", () => {
  const remove = vi.fn();
  const attachment = { id: "shot", path: "shot", name: "shot.png", mimeType: "image/png" as const, size: 10, snapshot: snapshotFixture() };
  render(<ComposerAttachmentList attachments={[attachment]} onRemove={remove} />);
  expect(screen.getByText("Notes")).toBeInTheDocument();
  expect(screen.getByText("Release checklist")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove attachment shot.png" }));
  expect(remove).toHaveBeenCalledWith(attachment);
});

it("keeps split composers from cancelling each other's deliveries and binds the focused pane", async () => {
  let listener!: (value: SnapshotDelivery) => void;
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null }));
  const cancel = vi.fn(async () => undefined);
  const onSnapshot = vi.fn((fn) => { listener = fn; return () => undefined; });
  window.inertia = { ...original, snapshot, onSnapshot, cancelAttachmentImport: cancel };
  const primary = vi.fn(async () => undefined); const secondary = vi.fn(async () => undefined);
  function Pane({ id, adopt }: { id: string; adopt: typeof primary }) {
    const ref = useRef<HTMLTextAreaElement>(null); useComposerSnapshots(id, adopt, ref);
    return <div className="conversation-pane-chat"><textarea ref={ref} aria-label={id} /></div>;
  }
  render(<><Pane id="primary" adopt={primary} /><Pane id="secondary" adopt={secondary} /></>);
  expect(onSnapshot).toHaveBeenCalledOnce();
  fireEvent.focusIn(screen.getByRole("textbox", { name: "secondary" }));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "bind", conversationId: "secondary" });
  act(() => listener({ conversationId: "secondary", selection: { batchId: "snapshot-split", attachments: [] } }));
  await waitFor(() => expect(secondary).toHaveBeenCalledOnce());
  expect(primary).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it("renders the compact command and an accessible provider-confirmed divider", () => {
  render(<ContextCompactionRow message={{ id: "receipt", conversationId: "chat", turnId: null, role: "system", content: "/compact", attachments: [], createdAt: "2026-09-08T09:00:00.000Z", compaction: { providerId: "codex", beforeTokens: 173000, afterTokens: 5690, instructionForwarded: false } }} />);
  expect(screen.getByText("/compact")).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Compacted context 173K → 5.69K tokens" })).toBeInTheDocument();
});
