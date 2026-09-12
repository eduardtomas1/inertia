import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { startTransition, Suspense, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";
import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import { ContextCompactionRow } from "../../src/renderer/src/components/response-timeline/ContextCompactionRow";
import { SnapshotControl } from "../../src/renderer/src/components/composer/SnapshotControl";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const original = window.inertia;
afterEach(() => { window.inertia = original; vi.restoreAllMocks(); });

it("suspends the native preview for snapshot settings and capture errors, restoring it on close or unmount", async () => {
  window.inertia = { ...original, snapshot: vi.fn(async () => ({ enabled: true, shortcut: "accelerator" as const, available: true, permission: "granted" as const, message: null })) };
  const view = render(<SnapshotControl conversationId="preview-chat" />);
  const trigger = screen.getByRole("button", { name: "Snapshots" });
  trigger.focus();
  expect(nativePreviewSuspended()).toBe(false);

  fireEvent.click(trigger);
  expect(nativePreviewSuspended()).toBe(true);
  expect(screen.getByRole("button", { name: "Close Snapshots" })).toHaveFocus();
  await screen.findByRole("combobox", { name: "Capture shortcut" });
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Snapshots" }), { key: "Escape" });
  expect(nativePreviewSuspended()).toBe(false);
  expect(trigger).toHaveFocus();

  act(() => window.dispatchEvent(new CustomEvent("inertia:snapshot-error", {
    detail: { conversationId: "preview-chat", message: "The capture could not be attached." },
  })));
  expect(screen.getByRole("alert")).toHaveTextContent("The capture could not be attached.");
  expect(nativePreviewSuspended()).toBe(true);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole("button", { name: "Close Snapshots" }));
  expect(nativePreviewSuspended()).toBe(false);
  expect(trigger).toHaveFocus();

  fireEvent.click(trigger);
  expect(nativePreviewSuspended()).toBe(true);
  view.unmount();
  expect(nativePreviewSuspended()).toBe(false);
});

it.each(["Linux x86_64", "Linux aarch64", "MacIntel", "Win32"])("offers only supported snapshot shortcuts on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  window.inertia = { ...original, snapshot: vi.fn(async () => ({ enabled: true, shortcut: "accelerator" as const, available: true, permission: "granted" as const, message: null })) };
  render(<SnapshotControl conversationId="shortcut-chat" />);
  fireEvent.click(screen.getByRole("button", { name: "Snapshots" }));
  await screen.findByRole("combobox", { name: "Capture shortcut" });
  expect(screen.getByText(/Experimental capture of the foreground window/u)).toBeVisible();
  expect(screen.getByText(/Detected editable fields are masked.*may still contain sensitive information.*Review before sending/u)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Enable Snapshots" })).toBeChecked();
  expect(screen.queryByRole("option", { name: "Both Shift keys" }) !== null).toBe(!platform.startsWith("Linux"));
});

it("routes a delivered snapshot only to its captured conversation and cancels stale leases", async () => {
  let listener!: (value: SnapshotDelivery) => void;
  const cancel = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const adopt = vi.fn(async () => "adopted" as const);
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

it("unbinds the final composer and cancels queued delivery before and after native acknowledgment", async () => {
  let listener: ((value: SnapshotDelivery) => void) | null = null; let acknowledge!: () => void;
  const stop = vi.fn(() => { listener = null; }); const cancel = vi.fn(async () => undefined);
  const state = { enabled: true, shortcut: "accelerator" as const, available: true, permission: "granted" as const, message: null };
  const snapshot = vi.fn(async (request: { type: string }) => {
    if (request.type === "unbind") await new Promise<void>((resolve) => { acknowledge = resolve; });
    return state;
  });
  window.inertia = { ...original, snapshot, onSnapshot: (fn) => { listener = fn; return stop; }, cancelAttachmentImport: cancel };
  const hook = renderHook(() => useComposerSnapshots("chat-a", async () => "adopted", useRef<HTMLTextAreaElement>(null)));
  hook.unmount();
  expect(snapshot).toHaveBeenLastCalledWith({ type: "unbind" });
  expect(stop).not.toHaveBeenCalled();
  act(() => listener?.({ conversationId: "chat-a", selection: { batchId: "queued-before-unbind", attachments: [] } }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("queued-before-unbind"));
  await act(async () => acknowledge());
  act(() => listener?.({ conversationId: "chat-a", selection: { batchId: "delivered-after-unbind", attachments: [] } }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("delivered-after-unbind"));
  expect(stop).not.toHaveBeenCalled();
});

it("keeps one window subscription across remounts and out-of-order unbind acknowledgments", async () => {
  const stop = vi.fn(); const acknowledgments: Array<() => void> = [];
  const snapshot = vi.fn(async (request: { type: string }) => {
    if (request.type === "unbind") await new Promise<void>((resolve) => acknowledgments.push(resolve));
    return { enabled: true, shortcut: "accelerator" as const, available: true, permission: "granted" as const, message: null };
  });
  const onSnapshot = vi.fn(() => stop);
  window.inertia = { ...original, snapshot, onSnapshot };
  const mount = () => renderHook(() => useComposerSnapshots("chat-a", async () => "adopted", useRef<HTMLTextAreaElement>(null)));
  mount().unmount(); mount().unmount();
  expect(acknowledgments).toHaveLength(2);
  await act(async () => acknowledgments[0]!());
  expect(stop).not.toHaveBeenCalled();
  await act(async () => acknowledgments[1]!());
  expect(stop).not.toHaveBeenCalled();
  expect(onSnapshot).toHaveBeenCalledOnce();
});

it("cancels a delivery during an uncommitted conversation transition before invoking another chat's adoption", async () => {
  let listener!: (value: SnapshotDelivery) => void;
  const attemptedNextConversation = vi.fn();
  const pending = new Promise<void>(() => undefined);
  const cancel = vi.fn(async () => undefined);
  const first = vi.fn(async () => "adopted" as const); const next = vi.fn(async () => "adopted" as const);
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null }));
  window.inertia = { ...original, snapshot, onSnapshot: (fn) => { listener = fn; return () => undefined; }, cancelAttachmentImport: cancel };
  function Pane({ id }: { id: string }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useComposerSnapshots(id, id === "chat-a" ? first : next, ref);
    if (id === "chat-b") { attemptedNextConversation(); throw pending; }
    return <textarea ref={ref} aria-label={id} />;
  }
  function Workspace() {
    const [id, setId] = useState("chat-a");
    return <><button onClick={() => startTransition(() => setId("chat-b"))}>Next chat</button><Suspense fallback={<span>Loading chat</span>}><Pane id={id} /></Suspense></>;
  }
  render(<Workspace />);
  const errors = vi.fn(); window.addEventListener("inertia:snapshot-error", errors);
  act(() => listener({ conversationId: "chat-a", error: "A current capture failed." }));
  expect(errors).toHaveBeenCalledOnce(); errors.mockClear();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next chat" })); });
  expect(attemptedNextConversation).toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "chat-a" })).toBeVisible();
  expect(snapshot).toHaveBeenLastCalledWith({ type: "bind", conversationId: "chat-a" });
  act(() => listener({ conversationId: "chat-a", error: "A stale capture failed." }));
  expect(errors).not.toHaveBeenCalled(); window.removeEventListener("inertia:snapshot-error", errors);
  act(() => listener({ conversationId: "chat-a", selection: { batchId: "during-transition", attachments: [] } }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("during-transition"));
  expect(first).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
});

it("keeps split composers from cancelling each other's deliveries and binds the focused pane", async () => {
  let listener!: (value: SnapshotDelivery) => void;
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null }));
  const cancel = vi.fn(async () => undefined);
  const onSnapshot = vi.fn((fn) => { listener = fn; return () => undefined; });
  window.inertia = { ...original, snapshot, onSnapshot, cancelAttachmentImport: cancel };
  const primary = vi.fn(async () => "adopted" as const); const secondary = vi.fn(async () => "adopted" as const);
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
