import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTimelineItemFocus } from "../../src/renderer/src/components/response-timeline/timeline-item-focus";
import { CommandPalette } from "../../src/renderer/src/components/CommandPalette";
import { useMessageSearch } from "../../src/renderer/src/hooks/useMessageSearch";
import type { ClientCommand, Project, ServerEvent } from "../../src/shared/contracts";
import type { MessageSearchHit, MessageSearchResult } from "../../src/shared/message-search";
import { conversation, deferred } from "./composer-fixtures";

const chat = conversation("22222222-2222-4222-8222-222222222222");
const hit: MessageSearchHit = {
  projectId: chat.projectId, conversationId: chat.id, turnId: "legacy-turn", messageId: "message",
  role: "assistant", createdAt: chat.createdAt,
  snippet: "Found needle <img src=x onerror=alert(1)>", matchStart: 6, matchEnd: 12,
};
function response(query = "needle", extra: Partial<MessageSearchResult> = {}): ServerEvent {
  return { type: "request.result", requestId: "request", result: {
    kind: "conversation.messages.search", query, hits: [hit], hasMore: false, incomplete: false, ...extra,
  } };
}
async function debounce() { await act(() => vi.advanceTimersByTimeAsync(201)); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("message search in the palette", () => {
  it.each(["accepted", "cancelled"])("preserves the correct focus after %s message selection", async (outcome) => {
    vi.useFakeTimers();
    const noOp = (): void => undefined;
    let cancelFocus = (): void => undefined;
    function Harness() {
      const [open, setOpen] = useState(false);
      const [revealed, setRevealed] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open search</button>
        <section aria-label="Saved history">{revealed && <article tabIndex={-1} aria-label="Selected message">Saved answer</article>}</section>
        <CommandPalette open={open} projects={[{ id: chat.projectId, name: "Inertia", path: "/workspace" } as Project]} conversations={[chat]}
          newThreadShortcut="Ctrl+N" sendCommand={async () => response()}
          onSelectMessage={async () => {
            cancelFocus = startTimelineItemFocus({
              root: screen.getByRole("region", { name: "Saved history" }), scrollElement: null,
              index: 0, align: "center", virtualized: false, scrollToIndex: noOp,
              resolveTarget: (root) => {
                const row = root.querySelector("article");
                return row ? { row, destination: row } : null;
              },
            });
            return true;
          }}
          onClose={() => { setOpen(false); setRevealed(true); }} onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onAddProject={noOp} onOpenSettings={noOp}
        />
      </>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open search" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    await debounce();
    await act(async () => { fireEvent.keyDown(input, { key: outcome === "accepted" ? "Enter" : "Escape" }); });
    expect(screen.queryByRole("combobox")).toBeNull();
    try {
      await act(() => vi.advanceTimersByTimeAsync(32));
      expect(outcome === "accepted" ? screen.getByRole("article", { name: "Selected message" }) : opener).toHaveFocus();
    } finally { cancelFocus(); }
  });

  it.each(["query", "close", "unmount"])("cancels pending navigation on %s and ignores its late completion", async (change) => {
    vi.useFakeTimers();
    const selected = deferred<boolean>();
    const select = vi.fn<(_: MessageSearchHit, signal?: AbortSignal) => Promise<boolean>>(() => selected.promise);
    const close = vi.fn();
    const noOp = (): void => undefined;
    const view = render(<CommandPalette open projects={[{ id: chat.projectId, name: "Inertia", path: "/workspace" } as Project]} conversations={[chat]}
      newThreadShortcut="Ctrl+N" sendCommand={async () => response()} onSelectMessage={select}
      onClose={close} onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onAddProject={noOp} onOpenSettings={noOp}
    />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    await debounce();
    fireEvent.keyDown(input, { key: "Enter" });
    const signal = select.mock.calls[0]![1]!;
    expect(signal.aborted).toBe(false);
    if (change === "query") fireEvent.change(input, { target: { value: "different" } });
    else if (change === "close") fireEvent.keyDown(input, { key: "Escape" });
    else view.unmount();
    expect(signal.aborted).toBe(true);
    close.mockClear();
    await act(async () => selected.resolve(true));
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    if (change === "query") expect(input).toHaveValue("different");
  });

  it("keeps the query and palette on failed selection and closes only after a successful retry", async () => {
    vi.useFakeTimers();
    const selected = deferred<boolean>();
    const select = vi.fn(() => selected.promise);
    const close = vi.fn();
    const noOp = (): void => undefined;
    render(<CommandPalette open projects={[{ id: chat.projectId, name: "Inertia", path: "/workspace" } as Project]} conversations={[chat]}
      newThreadShortcut="Ctrl+N" sendCommand={async () => response()} onSelectMessage={select}
      onClose={close} onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onAddProject={noOp} onOpenSettings={noOp}
    />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    await debounce();
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => selected.resolve(false));
    expect(close).not.toHaveBeenCalled();
    expect(input).toHaveValue("needle");
    expect(input).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not open this message");
    select.mockResolvedValue(true);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(close).toHaveBeenCalledOnce();
  });

  it("debounces, cancels superseded work and ignores stale responses", async () => {
    vi.useFakeTimers();
    const first = deferred<ServerEvent>();
    const second = deferred<ServerEvent>();
    const send = vi.fn((command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "conversation.messages.search") return command.payload.query === "first" ? first.promise : second.promise;
      return Promise.resolve({ type: "request.ok", requestId: command.requestId });
    });
    const hook = renderHook(({ query, open }) => useMessageSearch(open, query, send), { initialProps: { query: "a", open: true } });
    await debounce();
    expect(send).not.toHaveBeenCalled();
    hook.rerender({ query: "first", open: true });
    expect(hook.result.current.loading).toBe(true);
    await debounce();
    const request = send.mock.calls[0]![0];
    hook.rerender({ query: "second", open: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation.messages.search.cancel", payload: { searchRequestId: request.requestId } }));
    await debounce();
    await act(async () => first.resolve(response("first")));
    expect(hook.result.current.result).toBeNull();
    await act(async () => second.resolve(response("second")));
    expect(hook.result.current.result?.query).toBe("second");
    hook.rerender({ query: "third", open: true });
    await debounce();
    hook.rerender({ query: "third", open: false });
    expect(hook.result.current.result).toBeNull();
  });

  it("cancels an in-flight request when the palette unmounts", async () => {
    vi.useFakeTimers();
    const pending = deferred<ServerEvent>();
    const send = vi.fn((command: ClientCommand) => command.type === "conversation.messages.search"
      ? pending.promise : Promise.resolve({ type: "request.ok" as const, requestId: command.requestId }));
    const hook = renderHook(() => useMessageSearch(true, "needle", send));
    await debounce();
    hook.unmount();
    expect(send.mock.calls[1]?.[0].type).toBe("conversation.messages.search.cancel");
    await act(async () => pending.resolve(response()));
  });

  it("shows escaped snippets, supports keyboard selection and discloses bounded results", async () => {
    vi.useFakeTimers();
    const onSelectMessage = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ServerEvent> => response("needle", { hasMore: true, incomplete: true }));
    const noOp = (): void => undefined;
    const view = render(<CommandPalette
      open projects={[{ id: chat.projectId, name: "Inertia", path: "/workspace" } as Project]} conversations={[chat]}
      newThreadShortcut="Ctrl+N" sendCommand={send} onSelectMessage={onSelectMessage}
      onClose={noOp} onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onAddProject={noOp} onOpenSettings={noOp}
    />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByRole("status")).toHaveTextContent("Searching messages");
    expect(screen.queryByText("No matches")).toBeNull();
    await debounce();
    const option = screen.getByRole("option");
    expect(option).toHaveTextContent(hit.snippet);
    expect(option.querySelector("mark")).toHaveTextContent("needle");
    expect(option.querySelector("img")).toBeNull();
    expect(view.container.querySelectorAll("[role=status]")).toHaveLength(2);
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(onSelectMessage).toHaveBeenCalledWith(hit, expect.any(AbortSignal));
  });

  it("retries a failed search from the palette and returns focus to the input", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(_: ClientCommand) => Promise<ServerEvent>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(response());
    const noOp = (): void => undefined;
    render(<CommandPalette open projects={[{ id: chat.projectId, name: "Inertia", path: "/workspace" } as Project]} conversations={[chat]}
      newThreadShortcut="Ctrl+N" sendCommand={send} onSelectMessage={async () => true}
      onClose={noOp} onSelectProject={noOp} onSelectConversation={noOp} onNewThread={noOp} onAddProject={noOp} onOpenSettings={noOp}
    />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    await debounce();
    expect(screen.queryByText("No matches")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(input).toHaveFocus();
    await debounce();
    expect(screen.getByRole("option")).toHaveTextContent(hit.snippet);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("navigates in displayed group order, keeps selection by identity and ignores composition Enter", async () => {
    vi.useFakeTimers();
    const select = vi.fn(async () => true);
    const noOp = (): void => undefined;
    const props = {
      open: true, projects: [{ id: chat.projectId, name: "A needle project", path: "/workspace" } as Project],
      conversations: [{ ...chat, title: "Needle chat" }], newThreadShortcut: "Ctrl+N",
      sendCommand: async () => response("needle", { hits: [{ ...hit, snippet: "needle and NEEDLE", matchStart: 0, matchEnd: 6 }] }),
      onSelectMessage: select, onClose: noOp, onSelectProject: noOp, onSelectConversation: noOp,
      onNewThread: noOp, onAddProject: noOp, onOpenSettings: noOp,
    };
    const view = render(<CommandPalette {...props} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "needle" } });
    await debounce();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("A needle project");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    for (const option of options.slice(1)) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input).toHaveAttribute("aria-activedescendant", option.id);
    }
    expect(options[2]!.querySelectorAll(".palette-message-snippet mark")).toHaveLength(2);
    fireEvent.pointerEnter(options[0]!);
    expect(input).toHaveAttribute("aria-activedescendant", options[2]!.id);
    fireEvent.pointerMove(options[0]!);
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.pointerMove(options[2]!);
    view.rerender(<CommandPalette {...props} projects={[{ ...props.projects[0]!, id: "additional", name: "Needle" }, ...props.projects]} />);
    expect(input).toHaveAttribute("aria-activedescendant", options[2]!.id);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(select).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(select).toHaveBeenCalledOnce();
  });

  it("surfaces failures without leaking details, and retries the same query", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(_: ClientCommand) => Promise<ServerEvent>>()
      .mockRejectedValueOnce(new Error("private path"))
      .mockResolvedValueOnce(response());
    const hook = renderHook(({ query }) => useMessageSearch(true, query, send), { initialProps: { query: "needle" } });
    await debounce();
    expect(hook.result.current.error).toContain("unavailable");
    expect(hook.result.current.error).not.toContain("private");
    act(() => hook.result.current.retry());
    await debounce();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.result?.hits).toEqual([hit]);
  });
});
