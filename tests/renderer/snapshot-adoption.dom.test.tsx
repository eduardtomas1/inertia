import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../src/shared/contracts";
import { MAX_CHAT_ATTACHMENTS } from "../../src/shared/attachments";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import { composerAttachmentActions } from "../../src/renderer/src/components/composer/composerAttachmentActions";
import { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const original = window.inertia;
const removeListeners: Array<() => void> = [];
afterEach(() => { cleanup(); for (const remove of removeListeners.splice(0)) remove(); window.inertia = original; });

function fixture(mode: "ready" | "submitting" | "importing" | "blocked" | "full" | "commit-rejected" = "ready", split = false) {
  let listener!: (event: SnapshotDelivery) => void;
  const errors: unknown[] = [];
  const onError = (event: Event): void => { errors.push((event as CustomEvent<unknown>).detail); };
  window.addEventListener("inertia:snapshot-error", onError);
  removeListeners.push(() => window.removeEventListener("inertia:snapshot-error", onError));
  const commit = vi.fn(async (_batch: string, _ids: string[]): Promise<void> => undefined);
  const cancel = vi.fn(async (_batch: string): Promise<void> => undefined);
  const release = vi.fn(async (_id: string): Promise<void> => undefined);
  const existing: ChatAttachment[] = mode === "full" ? Array.from({ length: MAX_CHAT_ATTACHMENTS }, (_, index) => ({
    id: `existing-${index}`, path: `existing-${index}`, name: `${index}.png`, mimeType: "image/png", size: 10,
  })) : [];
  const options: Parameters<typeof composerAttachmentActions>[0] = {
    attachmentAuthorityKey: "authority-a", attachmentAuthorityRef: { current: { key: "authority-a", conversationId: "chat-a" } },
    attachmentImportSequenceRef: { current: 0 }, attachmentImportingRef: { current: mode === "importing" },
    attachmentsRef: { current: existing }, pendingAttachmentIdsRef: { current: new Set<string>() },
    blocked: mode === "blocked", conversationId: "chat-a", markEditorChanged: vi.fn(), mountedRef: { current: true },
    onChooseAttachments: async () => null, onImportAttachments: async () => null, releaseAttachmentRef: { current: release },
    running: false, setAttachments: vi.fn(), setAttachmentImporting: vi.fn(), setPendingAttachmentIds: vi.fn(),
    submittingRef: { current: mode === "submitting" },
  };
  if (mode === "commit-rejected") commit.mockRejectedValueOnce(new Error("commit denied /private/fixture.png"));
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "both-shift" as const, available: true, permission: "granted" as const, message: null }));
  window.inertia = { ...original, snapshot,
    onSnapshot: (callback) => { listener = callback; return () => undefined; }, commitAttachmentImport: commit, cancelAttachmentImport: cancel,
  };
  const actions = composerAttachmentActions(options);
  const secondaryActions = composerAttachmentActions({ ...options, conversationId: "chat-b", blocked: false,
    attachmentAuthorityKey: "authority-b", attachmentAuthorityRef: { current: { key: "authority-b", conversationId: "chat-b" } },
    attachmentImportSequenceRef: { current: 0 }, attachmentImportingRef: { current: false }, attachmentsRef: { current: [] },
    pendingAttachmentIdsRef: { current: new Set<string>() }, mountedRef: { current: true }, submittingRef: { current: false },
  });
  let pendingAdoption: ReturnType<typeof actions.adoptAttachments> | null = null;
  const adopt: typeof actions.adoptAttachments = (lease) => { pendingAdoption = actions.adoptAttachments(lease); return pendingAdoption; };
  function Pane({ id }: { id: string }) {
    const textarea = useRef<HTMLTextAreaElement>(null); useComposerSnapshots(id, id === "chat-a" ? adopt : secondaryActions.adoptAttachments, textarea);
    return <div className="conversation-pane-chat"><textarea ref={textarea} aria-label={`Snapshot destination ${id}`} /><button>Toolbar {id}</button></div>;
  }
  const tree = (id: string | null) => <><button>Keep focus here</button>{id !== null && <Pane id={id} />}{split && <Pane id="chat-b" />}</>;
  const view = render(tree("chat-a"));
  const button = screen.getByRole("button", { name: "Keep focus here" }); button.focus();
  const attachment: ChatAttachment = { id: "shot", path: "shot", name: "snapshot.png", mimeType: "image/png", size: 10, snapshot: snapshotFixture() };
  return { options, existing, errors, commit, cancel, release, button, snapshot,
    deliver: () => { act(() => listener({ conversationId: "chat-a", selection: { batchId: "snapshot-batch", attachments: [attachment] } })); },
    settle: async () => { await act(async () => { await pendingAdoption; }); },
    change: (id: string | null) => {
      options.mountedRef.current = id !== null;
      options.attachmentAuthorityRef.current = { key: "authority-b", conversationId: id ?? "" };
      view.rerender(tree(id));
    },
  };
}

it.each(["submitting", "importing", "blocked", "full", "commit-rejected"] as const)("reports rejected snapshot adoption without success focus: %s", async (mode) => {
  const value = fixture(mode); value.deliver(); await value.settle();
  expect(value.errors).toEqual([{ conversationId: "chat-a", message: "Snapshot could not be attached." }]);
  expect(value.button).toHaveFocus();
  expect(value.cancel).toHaveBeenCalledExactlyOnceWith("snapshot-batch");
  expect(value.options.attachmentsRef.current).toEqual(value.existing);
  expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
  expect(value.release).not.toHaveBeenCalled();
  expect(value.options.attachmentImportingRef.current).toBe(mode === "importing");
});

it("focuses the snapshot destination only after its privileged commit succeeds", async () => {
  const value = fixture(); let finish!: () => void;
  value.commit.mockImplementationOnce(async () => await new Promise<void>((resolve) => { finish = resolve; }));
  value.deliver(); await waitFor(() => expect(value.commit).toHaveBeenCalledExactlyOnceWith("snapshot-batch", ["shot"]));
  expect(value.button).toHaveFocus(); expect(value.options.pendingAttachmentIdsRef.current.has("shot")).toBe(true);
  finish(); await value.settle();
  expect(screen.getByRole("textbox", { name: "Snapshot destination chat-a" })).toHaveFocus();
  expect(value.options.attachmentsRef.current.map(({ id }) => id)).toEqual(["shot"]);
  expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
  expect(value.errors).toEqual([]); expect(value.cancel).not.toHaveBeenCalled();
});

it("preserves the newer focused composer when another pane's snapshot commit finishes", async () => {
  const value = fixture("ready", true); let finish!: () => void;
  value.commit.mockImplementationOnce(async () => await new Promise<void>((resolve) => { finish = resolve; }));
  value.deliver(); await waitFor(() => expect(value.commit).toHaveBeenCalledExactlyOnceWith("snapshot-batch", ["shot"]));
  const other = screen.getByRole("textbox", { name: "Snapshot destination chat-b" }); other.focus();
  expect(value.snapshot).toHaveBeenLastCalledWith({ type: "bind", conversationId: "chat-b" });
  finish(); await value.settle();
  expect(other).toHaveFocus(); expect(value.snapshot).toHaveBeenLastCalledWith({ type: "bind", conversationId: "chat-b" });
  expect(value.options.attachmentsRef.current.map(({ id }) => id)).toEqual(["shot"]);
  expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
  expect(value.errors).toEqual([]); expect(value.cancel).not.toHaveBeenCalled();
});

it.each(["toolbar", "modal", "pointer"])("preserves newer %s interaction in the same pane during snapshot adoption", async (intent) => {
  const value = fixture(); let finish!: () => void;
  value.commit.mockImplementationOnce(async () => await new Promise<void>((resolve) => { finish = resolve; }));
  value.deliver(); await waitFor(() => expect(value.commit).toHaveBeenCalledOnce());
  const target = screen.getByRole("button", { name: "Toolbar chat-a" });
  if (intent === "modal") {
    const dialog = document.createElement("dialog"); const input = document.createElement("input");
    dialog.append(input); document.body.append(dialog); input.focus();
    removeListeners.push(() => dialog.remove());
  } else if (intent === "toolbar") target.focus();
  else target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const focusedBefore = document.activeElement;
  finish(); await value.settle();
  expect(document.activeElement).toBe(focusedBefore);
  expect(value.options.attachmentsRef.current.map(({ id }) => id)).toEqual(["shot"]);
  expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
  expect(value.errors).toEqual([]);
});

it("keeps a committed lease with expired turn authority silent and releases only its adopted IDs", async () => {
  const value = fixture(); let finish!: () => void;
  value.commit.mockImplementationOnce(async () => await new Promise<void>((resolve) => { finish = resolve; }));
  value.deliver(); await waitFor(() => expect(value.commit).toHaveBeenCalledOnce());
  value.options.attachmentAuthorityRef.current.key = "next-turn";
  finish(); await value.settle();
  expect(value.button).toHaveFocus(); expect(value.errors).toEqual([]);
  expect(value.release).toHaveBeenCalledExactlyOnceWith("shot");
  expect(value.cancel).not.toHaveBeenCalled(); expect(value.options.attachmentsRef.current).toEqual([]);
  expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
});

it.each(["authority", "unmounted"])("cancels an incoming lease silently when its %s owner is already invalid", async (reason) => {
  const value = fixture();
  if (reason === "authority") value.options.attachmentAuthorityRef.current.key = "next-turn";
  else value.options.mountedRef.current = false;
  value.deliver(); await value.settle();
  expect(value.errors).toEqual([]); expect(value.button).toHaveFocus();
  expect(value.commit).not.toHaveBeenCalled(); expect(value.cancel).toHaveBeenCalledExactlyOnceWith("snapshot-batch");
  expect(value.options.attachmentsRef.current).toEqual([]);
});

it.each(["chat-b", null])("keeps a late commit rejection silent after the destination changes to %s", async (id) => {
  const value = fixture(); let reject!: (error: Error) => void;
  value.commit.mockImplementationOnce(async () => await new Promise<void>((_resolve, rejectCommit) => { reject = rejectCommit; }));
  value.deliver(); await waitFor(() => expect(value.commit).toHaveBeenCalledOnce());
  value.change(id); reject(new Error("private commit detail")); await value.settle();
  expect(value.errors).toEqual([]); expect(value.button).toHaveFocus();
  expect(value.cancel).toHaveBeenCalledExactlyOnceWith("snapshot-batch");
  expect(value.options.attachmentsRef.current).toEqual([]); expect(value.options.pendingAttachmentIdsRef.current.size).toBe(0);
});
