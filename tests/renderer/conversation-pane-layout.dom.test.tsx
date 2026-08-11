import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useConversationPaneLayout } from "../../src/renderer/src/hooks/useConversationPaneLayout";

function toolKey(conversationId: string): string {
  return `inertia:layout:split-pane-tool:${conversationId}:v1`;
}

function openKey(conversationId: string): string {
  return `inertia:layout:split-pane-open:${conversationId}:v1`;
}

describe("useConversationPaneLayout", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Storage,
    });
  });

  it("projects the new conversation's tool state on its first render", () => {
    window.localStorage.setItem(toolKey("alpha"), "terminal");
    window.localStorage.setItem(openKey("alpha"), "true");
    window.localStorage.setItem(toolKey("beta"), "preview");
    window.localStorage.setItem(openKey("beta"), "true");
    const observations: Array<{
      conversationId: string;
      activeTool: string | null;
      toolsVisible: boolean;
    }> = [];
    const hook = renderHook(
      ({ conversationId }: { conversationId: string }) => {
        const layout = useConversationPaneLayout(conversationId);
        observations.push({
          conversationId,
          activeTool: layout.activeTool,
          toolsVisible: layout.toolsVisible,
        });
        return layout;
      },
      { initialProps: { conversationId: "alpha" } },
    );

    expect(hook.result.current.activeTool).toBe("terminal");
    observations.length = 0;
    hook.rerender({ conversationId: "beta" });

    expect(observations[0]).toEqual({
      conversationId: "beta",
      activeTool: "preview",
      toolsVisible: true,
    });
    expect(hook.result.current.activeTool).toBe("preview");
  });

  it("does not briefly reopen tools for a conversation persisted as closed", () => {
    window.localStorage.setItem(toolKey("alpha"), "files");
    window.localStorage.setItem(openKey("alpha"), "true");
    window.localStorage.setItem(toolKey("beta"), "changes");
    window.localStorage.setItem(openKey("beta"), "false");
    const observations: Array<{
      conversationId: string;
      activeTool: string | null;
      toolsVisible: boolean;
    }> = [];
    const hook = renderHook(
      ({ conversationId }: { conversationId: string }) => {
        const layout = useConversationPaneLayout(conversationId);
        observations.push({
          conversationId,
          activeTool: layout.activeTool,
          toolsVisible: layout.toolsVisible,
        });
        return layout;
      },
      { initialProps: { conversationId: "alpha" } },
    );

    observations.length = 0;
    hook.rerender({ conversationId: "beta" });

    expect(observations[0]).toEqual({
      conversationId: "beta",
      activeTool: null,
      toolsVisible: false,
    });
    expect(hook.result.current.activeTool).toBeNull();
  });

  it("opens Environment first without borrowing another task's last panel", () => {
    window.localStorage.setItem(
      "inertia:layout:last-workspace-tool:v2",
      "terminal",
    );
    const hook = renderHook(() => useConversationPaneLayout("alpha"));

    expect(hook.result.current.activeTool).toBeNull();
    act(() => hook.result.current.toggleWorkspaceTools());

    expect(hook.result.current.activeTool).toBe("environment");
    expect(window.localStorage.getItem(toolKey("alpha")))
      .toBe("environment");
  });
});
