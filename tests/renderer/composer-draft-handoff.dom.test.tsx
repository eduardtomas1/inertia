import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DetachedChatDraftHandoff,
  PendingDetachedChatDraft,
} from "../../src/shared/desktop";
import { Composer } from "../../src/renderer/src/components/Composer";
import { useDetachedChatWindows } from "../../src/renderer/src/hooks/useDetachedChatWindows";
import {
  handOffComposerDraft,
  takeComposerDraft,
} from "../../src/renderer/src/utils/composerDraftPersistence";
import { prepareComposerDetachment } from "../../src/renderer/src/utils/composerOwnership";

import { composerProps, conversation } from "./composer-fixtures";

function rejectStorageWrites(): void {
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is full.", "QuotaExceededError");
  });
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

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

describe("composer draft handoff", () => {
  it.each([
    ["accepts", false],
    ["rejects", true],
  ] as const)("docks the newer detached draft of a routed chat when storage %s writes", async (_label, failing) => {
    const target = conversation(`handoff-detach-${String(failing)}`);
    const bridge = installDetachedChatBridge();
    renderHook(() => useDetachedChatWindows());
    if (failing) rejectStorageWrites();

    handOffComposerDraft(target.id, "Routed request");
    const routed = render(<Composer {...composerProps(target)} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Routed request"));
    expect(prepareComposerDetachment(target.id)).toEqual({ status: "ready", draft: "Routed request" });
    routed.unmount();

    act(() => bridge.mirror({ conversationId: target.id, draft: "Edited in the detached window" }));
    act(() => bridge.dock({
      conversationId: target.id,
      draft: "Edited in the detached window",
      handoffId: "81818181-8181-4181-8181-818181818181",
    }));
    render(<Composer {...composerProps(target)} />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Edited in the detached window"));
  });

  it("docks the newer detached draft when the routed chat was never opened in this window", () => {
    const target = conversation("handoff-detach-unopened");
    const bridge = installDetachedChatBridge();
    renderHook(() => useDetachedChatWindows());
    rejectStorageWrites();

    handOffComposerDraft(target.id, "Routed request");
    expect(prepareComposerDetachment(target.id)).toEqual({ status: "ready", draft: "Routed request" });
    act(() => bridge.mirror({ conversationId: target.id, draft: "Edited in the detached window" }));

    expect(prepareComposerDetachment(target.id)).toEqual({ status: "ready", draft: "Edited in the detached window" });
    render(<Composer {...composerProps(target)} />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Edited in the detached window");
  });

  it("returns a handoff at most once", () => {
    rejectStorageWrites();
    handOffComposerDraft("handoff-once", "Routed request");

    expect(takeComposerDraft("handoff-once")).toBe("Routed request");
    expect(takeComposerDraft("handoff-once")).toBe("");
  });
});
