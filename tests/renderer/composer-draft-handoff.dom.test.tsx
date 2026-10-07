import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DetachedChatDraftHandoff,
  PendingDetachedChatDraft,
} from "../../src/shared/desktop";
import { MAX_CHAT_MESSAGE_CHARS } from "../../src/shared/diff-review";
import { Composer } from "../../src/renderer/src/components/Composer";
import { useDetachedChatWindows } from "../../src/renderer/src/hooks/useDetachedChatWindows";
import {
  clearPersistedComposerDraft,
  MAX_UNSTORED_COMPOSER_DRAFTS,
  persistComposerDraft,
  readComposerDraft,
} from "../../src/renderer/src/utils/composerDraftPersistence";
import { prepareComposerDetachment } from "../../src/renderer/src/utils/composerOwnership";

import { composerProps, conversation } from "./composer-fixtures";

const storageSpies: { mockRestore: () => void }[] = [];

function rejectStorageWrites(): { restore: () => void } {
  const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is full.", "QuotaExceededError");
  });
  storageSpies.push(spy);
  return { restore: () => spy.mockRestore() };
}

function writeFromAnotherWindow(conversationId: string, draft: string): void {
  const key = `inertia:draft:${conversationId}`;
  window.localStorage.setItem(key, draft);
  window.dispatchEvent(new StorageEvent("storage", {
    key,
    newValue: draft,
    storageArea: window.localStorage,
  }));
}

function installDetachedChatBridge(): {
  mirror: (handoff: DetachedChatDraftHandoff) => void;
  dock: (handoff: PendingDetachedChatDraft) => void;
} {
  const listeners: {
    mirror?: (handoff: DetachedChatDraftHandoff) => void;
    dock?: (handoff: PendingDetachedChatDraft) => void;
  } = {};
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getDetachedChatWindows: vi.fn(async () => []),
      getPendingDetachedChatDrafts: vi.fn(async () => []),
      acknowledgeDetachedChatDraft: vi.fn(async () => true),
      onDetachedChatWindowsChanged: vi.fn(() => vi.fn()),
      onDetachedChatDraftChanged: vi.fn((listener: typeof listeners.dock) => {
        listeners.dock = listener;
        return vi.fn();
      }),
      onDetachedChatDraftMirrored: vi.fn((listener: typeof listeners.mirror) => {
        listeners.mirror = listener;
        return vi.fn();
      }),
      openDetachedChat: vi.fn(),
      focusDetachedChat: vi.fn(),
    },
  });
  return {
    mirror: (handoff) => listeners.mirror?.(handoff),
    dock: (handoff) => listeners.dock?.(handoff),
  };
}

function message(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

afterEach(() => {
  for (const spy of storageSpies.splice(0)) spy.mockRestore();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: window.localStorage }));
});

describe("composer draft persistence", () => {
  it.each([
    ["accepts", false],
    ["rejects", true],
  ] as const)("docks the newer detached draft of a routed chat when storage %s writes", async (_label, failing) => {
    const target = conversation(`handoff-detach-${String(failing)}`);
    const bridge = installDetachedChatBridge();
    renderHook(() => useDetachedChatWindows());
    if (failing) rejectStorageWrites();

    persistComposerDraft(target.id, "Routed request");
    const routed = render(<Composer {...composerProps(target)} />);
    await waitFor(() => expect(message()).toHaveValue("Routed request"));
    expect(prepareComposerDetachment(target.id)).toEqual({ status: "ready", draft: "Routed request" });
    routed.unmount();

    act(() => bridge.mirror({ conversationId: target.id, draft: "Edited in the detached window" }));
    act(() => bridge.dock({
      conversationId: target.id,
      draft: "Edited in the detached window",
      handoffId: "81818181-8181-4181-8181-818181818181",
    }));
    render(<Composer {...composerProps(target)} />);

    await waitFor(() => expect(message()).toHaveValue("Edited in the detached window"));
  });

  it.each([
    ["healthy", false],
    ["failing in this window only", true],
  ] as const)("lets another window's stored draft win when storage is %s", (_label, failing) => {
    const target = conversation(`storage-event-${String(failing)}`);
    const storage = failing ? rejectStorageWrites() : null;

    persistComposerDraft(target.id, "Routed request");
    const routed = render(<Composer {...composerProps(target)} />);
    expect(message()).toHaveValue("Routed request");
    routed.unmount();

    storage?.restore();
    act(() => writeFromAnotherWindow(target.id, "Edited in the detached window"));
    if (failing) rejectStorageWrites();

    expect(readComposerDraft(target.id)).toBe("Edited in the detached window");
    render(<Composer {...composerProps(target)} />);
    expect(message()).toHaveValue("Edited in the detached window");
  });

  it("keeps a draft typed while storage rejects writes across a conversation switch", () => {
    vi.useFakeTimers();
    try {
      const first = conversation("unstored-typed-first");
      const second = conversation("unstored-typed-second");
      rejectStorageWrites();
      const view = render(<Composer {...composerProps(first)} />);
      fireEvent.change(message(), { target: { value: "Typed while storage is full" } });
      fireEvent.change(message(), { target: { value: "Typed while storage is full, and more" } });

      view.rerender(<Composer {...composerProps(second)} />);
      expect(message()).toHaveValue("");
      view.rerender(<Composer {...composerProps(first)} />);

      expect(message()).toHaveValue("Typed while storage is full, and more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the unstored draft to every reader without consuming it", () => {
    rejectStorageWrites();
    persistComposerDraft("unstored-reads", "Routed request");

    expect(readComposerDraft("unstored-reads")).toBe("Routed request");
    expect(readComposerDraft("unstored-reads")).toBe("Routed request");
    expect(prepareComposerDetachment("unstored-reads")).toEqual({ status: "ready", draft: "Routed request" });
  });

  it("clears the unstored draft after a successful send", async () => {
    const current = conversation("unstored-send");
    const onSend = vi.fn(async () => undefined);
    rejectStorageWrites();
    const view = render(<Composer {...composerProps(current, { onSend })} />);
    fireEvent.change(message(), { target: { value: "Send me" } });
    expect(readComposerDraft(current.id)).toBe("Send me");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await waitFor(() => expect(message()).toHaveValue(""));

    expect(readComposerDraft(current.id)).toBe("");
    view.unmount();
    render(<Composer {...composerProps(current)} />);
    expect(message()).toHaveValue("");
  });

  it("clears an unstored draft only when the cleared draft matches it", () => {
    rejectStorageWrites();
    persistComposerDraft("unstored-sent", "Handed-off text");
    persistComposerDraft("unstored-kept", "Handed-off text");

    clearPersistedComposerDraft("unstored-sent", "Handed-off text");
    clearPersistedComposerDraft("unstored-kept", "A different draft");
    expect(readComposerDraft("unstored-sent")).toBe("");
    expect(readComposerDraft("unstored-kept")).toBe("Handed-off text");

    persistComposerDraft("unstored-kept", "");
    expect(readComposerDraft("unstored-kept")).toBe("");
  });

  it("bounds the unstored drafts by count and size", () => {
    rejectStorageWrites();
    for (let index = 0; index <= MAX_UNSTORED_COMPOSER_DRAFTS; index += 1) {
      persistComposerDraft(`unstored-bound-${index}`, `Draft ${index}`);
    }

    expect(readComposerDraft("unstored-bound-0")).toBe("");
    expect(readComposerDraft("unstored-bound-1")).toBe("Draft 1");
    expect(readComposerDraft(`unstored-bound-${MAX_UNSTORED_COMPOSER_DRAFTS}`))
      .toBe(`Draft ${MAX_UNSTORED_COMPOSER_DRAFTS}`);

    persistComposerDraft("unstored-oversized", "x".repeat(MAX_CHAT_MESSAGE_CHARS + 1));
    expect(readComposerDraft("unstored-oversized")).toBe("");
    expect(readComposerDraft("unstored-bound-1")).toBe("Draft 1");
  });
});
