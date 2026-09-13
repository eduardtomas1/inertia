import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useSplitPanes } from "../../src/renderer/src/hooks/useSplitPanes";

it.each(["getter", "operations"])(
  "keeps split-pane state usable when optional storage fails at its %s",
  (failure) => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    const unavailable = (): never => { throw new Error("Storage unavailable"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: failure === "getter"
        ? unavailable
        : () => ({ getItem: unavailable, setItem: unavailable, removeItem: unavailable }),
    });
    let hook: ReturnType<typeof renderHook<ReturnType<typeof useSplitPanes>, unknown>> | undefined;
    try {
      hook = renderHook(() => useSplitPanes({
        snapshot: null, detachedConversationIds: new Set(), detachedReady: true,
      }));
      expect(hook.result.current.splitConversationId).toBeNull();
      act(() => {
        hook!.result.current.setPaneConversation("secondary", "selected-chat");
        hook!.result.current.commitLayout({
          axis: "columns", ratio: 60,
          first: { owner: "primary" }, second: { owner: "secondary" },
        });
      });
      expect(hook.result.current.splitConversationId).toBe("selected-chat");
      act(() => hook!.result.current.closePane("secondary"));
      expect(hook.result.current.splitConversationId).toBeNull();
    } finally {
      hook?.unmount();
      if (original) Object.defineProperty(window, "localStorage", original);
      else Reflect.deleteProperty(window, "localStorage");
    }
  },
);
