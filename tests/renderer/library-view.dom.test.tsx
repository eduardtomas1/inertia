import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryView, type LibraryViewProps } from "../../src/renderer/src/components/LibraryView";
import { choosePreviewSlots } from "../../src/renderer/src/components/library/LibraryPages";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import type { LibrarySnapshot } from "../../src/shared/library";
import {
  category,
  createdCategoryId,
  library,
  missingConversationId,
  page,
  recipesId,
  researchId,
  result,
  savedAnswer,
} from "./library-fixtures";
import {
  conversation,
  conversationId,
  firstProjectId,
  NOW,
  ok,
  otherConversationId,
  sent,
  settings,
  snapshot,
  stamp,
  stubMatchMedia,
} from "./tasks-fixtures";

type Request = (command: CommandWithoutId) => Promise<ServerEvent>;

const research = category(researchId, "Research");
const recipes = category(recipesId, "Recipes");
const unsortedAnswer = savedAnswer({ title: "Retry budget decision", excerpt: "Three attempts with backoff." });
const researchAnswer = savedAnswer({ title: "Cache invalidation notes", categoryId: researchId, excerpt: "Keys expire hourly." });
const orphanAnswer = savedAnswer({ title: "Answer from a deleted chat", conversationId: missingConversationId, categoryId: researchId });
const archivedAnswer = savedAnswer({
  title: "Soup for a cold day",
  conversationId: otherConversationId,
  categoryId: recipesId,
  turnId: "archived-turn",
  messageId: "archived-message",
});

function appSnapshot(libraryValue: LibrarySnapshot, archived = true, confirmDestructiveActions = false): AppSnapshot {
  return snapshot([], {
    settings: { ...settings, confirmDestructiveActions },
    conversations: [
      conversation({ title: "Investigate request failures", status: "completed" }),
      conversation({
        id: otherConversationId,
        title: "Weekend cooking",
        status: "completed",
        archivedAt: archived ? stamp : null,
      }),
    ],
    library: libraryValue,
  });
}

const fullLibrary = library([research, recipes], [unsortedAnswer, researchAnswer, orphanAnswer, archivedAnswer]);

function harness(initial: AppSnapshot, request: Request = vi.fn<Request>(async () => ok())) {
  const onOpenAnswer = vi.fn();
  const onOpenTurn = vi.fn();
  const onError = vi.fn();
  const mock = request as ReturnType<typeof vi.fn<Request>>;
  const props = (value: AppSnapshot): LibraryViewProps => ({
    snapshot: value,
    status: "online",
    request: mock,
    onOpenAnswer,
    onOpenTurn,
    onError,
  });
  const view = render(<LibraryView {...props(initial)} />);
  return {
    ...view,
    request: mock,
    onOpenAnswer,
    onOpenTurn,
    onError,
    update(next: AppSnapshot) {
      view.rerender(<LibraryView {...props(next)} />);
    },
  };
}

function rail(): HTMLElement {
  return screen.getByRole("navigation", { name: "Categories" });
}

function railRow(name: string): HTMLElement {
  return within(rail()).getByText(name, { selector: ".library-category-name" }).closest("li")!;
}

function cardTitles(): string[] {
  return [...document.querySelectorAll(".library-card-open")].map((node) => node.textContent ?? "");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubMatchMedia();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Library view", () => {
  it("counts each category and hides answers whose chat no longer exists", () => {
    harness(appSnapshot(fullLibrary));
    expect(screen.getByRole("main", { name: "Library" })).toBeVisible();
    expect(screen.getByText("3 saved answers · 2 categories")).toBeVisible();
    const counts = [...rail().querySelectorAll(".library-category")].map((button) => [
      button.querySelector(".library-category-name")!.textContent,
      button.querySelector(".library-category-count")!.textContent,
    ]);
    expect(counts).toEqual([["All", "3"], ["Recipes", "1"], ["Research", "1"], ["Unsorted", "1"]]);
    expect(cardTitles()).toEqual(["Retry budget decision", "Cache invalidation notes", "Soup for a cold day"]);
    expect(screen.queryByText("Answer from a deleted chat")).toBeNull();
    expect(within(railRow("All")).getByRole("button", { name: /^All/u })).toHaveAttribute("aria-current", "true");
  });

  it("leaves Unsorted out of the rail when nothing is unsorted", () => {
    harness(appSnapshot(library([research], [researchAnswer])));
    expect(within(rail()).queryByText("Unsorted")).toBeNull();
  });

  it("filters by category and by search across titles, excerpts and chat titles", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    harness(appSnapshot(fullLibrary));
    await user.click(within(railRow("Research")).getByRole("button", { name: /^Research/u }));
    expect(cardTitles()).toEqual(["Cache invalidation notes"]);
    await user.click(within(railRow("All")).getByRole("button", { name: /^All/u }));

    const search = screen.getByRole("searchbox", { name: "Search the Library" });
    await user.type(search, "backoff");
    expect(cardTitles()).toEqual(["Retry budget decision"]);
    await user.clear(search);
    await user.type(search, "weekend");
    expect(cardTitles()).toEqual(["Soup for a cold day"]);
    await user.clear(search);
    await user.type(search, "nothing like this");
    expect(screen.getByText("Nothing matches “nothing like this”")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(cardTitles()).toHaveLength(3);
  });

  it("creates a category from the rail with Enter and cancels with Escape", async () => {
    const user = userEvent.setup();
    const request = vi.fn<Request>(async (command) => command.type === "library.category.create"
      ? result({ kind: "library.category", category: category(createdCategoryId, "Reading list") })
      : ok());
    const view = harness(appSnapshot(fullLibrary), request);

    await user.click(screen.getByRole("button", { name: "New category" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull();
    expect(screen.getByRole("button", { name: "New category" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New category" }));
    await user.type(screen.getByRole("textbox", { name: "New category name" }), "  Reading list {Enter}");
    expect(sent(view.request, "library.category.create")).toEqual([
      { type: "library.category.create", payload: { name: "Reading list" } },
    ]);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New category name" })).toBeNull());
  });

  it("keeps the name and explains a refused category inline", async () => {
    const user = userEvent.setup();
    const request = vi.fn<Request>(async () => { throw new Error("A category with that name already exists."); });
    harness(appSnapshot(fullLibrary), request);
    await user.click(screen.getByRole("button", { name: "New category" }));
    const input = screen.getByRole("textbox", { name: "New category name" });
    await user.type(input, "Research{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("A category with that name already exists.");
    expect(input).toHaveValue("Research");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("renames a category inline from its actions menu", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary));
    await user.click(screen.getByRole("button", { name: "Actions for Research" }));
    const menu = screen.getByRole("menu", { name: "Actions for Research" });
    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Research" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Investigations{Enter}");
    expect(sent(view.request, "library.category.rename")).toEqual([
      { type: "library.category.rename", payload: { categoryId: researchId, name: "Investigations" } },
    ]);
  });

  it("deletes a category straight away when destructive actions need no confirmation", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary));
    await user.click(screen.getByRole("button", { name: "Actions for Recipes" }));
    await user.click(within(screen.getByRole("menu", { name: "Actions for Recipes" })).getByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(sent(view.request, "library.category.delete")).toEqual([
      { type: "library.category.delete", payload: { categoryId: recipesId } },
    ]);
  });

  it("asks before deleting a category and says its answers move to Unsorted", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary, true, true));
    await user.click(within(railRow("Research")).getByRole("button", { name: /^Research/u }));
    await user.click(screen.getByRole("button", { name: "Actions for Research" }));
    await user.click(within(screen.getByRole("menu", { name: "Actions for Research" })).getByRole("menuitem", { name: "Delete…" }));
    const confirm = screen.getByRole("menu", { name: "Delete Research" });
    expect(confirm).toHaveTextContent("Delete “Research”?");
    expect(confirm).toHaveTextContent("Its 1 answer move to Unsorted.");
    expect(sent(view.request, "library.category.delete")).toEqual([]);
    await user.click(within(confirm).getByRole("menuitem", { name: "Delete category" }));
    expect(sent(view.request, "library.category.delete")).toEqual([
      { type: "library.category.delete", payload: { categoryId: researchId } },
    ]);
    expect(within(railRow("All")).getByRole("button", { name: /^All/u })).toHaveAttribute("aria-current", "true");
  });

  it("opens a saved answer at its exact message", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary));
    const card = screen.getByText("Retry budget decision").closest("li")!;
    await user.click(within(card).getByRole("button", { name: "Open in chat" }));
    expect(view.onOpenAnswer).toHaveBeenCalledWith({
      projectId: firstProjectId,
      conversationId,
      turnId: unsortedAnswer.turnId,
      messageId: unsortedAnswer.messageId,
    });
    await user.click(screen.getByRole("button", { name: "Cache invalidation notes" }));
    expect(view.onOpenAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: researchAnswer.messageId }));
  });

  it("restores an archived chat before opening its answer", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary));
    const card = screen.getByText("Soup for a cold day").closest("li")!;
    expect(within(card).getByText("Archived")).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "Restore and open" }));
    expect(sent(view.request, "conversation.unarchive")).toEqual([
      { type: "conversation.unarchive", payload: { conversationId: otherConversationId } },
    ]);
    expect(view.onOpenAnswer).not.toHaveBeenCalled();
    act(() => view.update(appSnapshot(fullLibrary, false)));
    expect(view.onOpenAnswer).toHaveBeenCalledWith({
      projectId: firstProjectId,
      conversationId: otherConversationId,
      turnId: "archived-turn",
      messageId: "archived-message",
    });
  });

  it("moves, renames and removes an answer from its card", async () => {
    const user = userEvent.setup();
    const view = harness(appSnapshot(fullLibrary));
    const card = () => screen.getByText("Retry budget decision").closest("li")!;
    await user.click(within(card()).getByRole("button", { name: "Move to category" }));
    const menu = screen.getByRole("menu", { name: "Move to category" });
    expect(within(menu).getByRole("menuitemradio", { name: "Unsorted" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemradio", { name: "Research" }));
    expect(sent(view.request, "library.answer.update")).toEqual([
      { type: "library.answer.update", payload: { savedAnswerId: unsortedAnswer.id, categoryId: researchId } },
    ]);
    expect(window.localStorage.getItem("inertia:library:last-category:v1")).toBe(researchId);

    await user.click(within(card()).getByRole("button", { name: "Rename" }));
    const title = screen.getByRole("textbox", { name: "Saved answer title" });
    await user.clear(title);
    await user.type(title, "Retry policy{Enter}");
    expect(sent(view.request, "library.answer.update").at(-1)).toEqual({
      type: "library.answer.update",
      payload: { savedAnswerId: unsortedAnswer.id, title: "Retry policy" },
    });

    await user.click(within(card()).getByRole("button", { name: "Remove from Library" }));
    expect(sent(view.request, "library.answer.remove")).toEqual([
      { type: "library.answer.remove", payload: { savedAnswerId: unsortedAnswer.id } },
    ]);
  });

  it("invites the first save when the Library is empty", () => {
    harness(appSnapshot(library([], [])));
    expect(screen.getByText("Nothing saved yet", { selector: ".library-empty-title" })).toBeVisible();
  });

  it("lists rendered pages when the Pages tab opens and sends Go to answer to the turn", async () => {
    const user = userEvent.setup();
    const request = vi.fn<Request>(async (command) => command.type === "library.pages.list"
      ? result({ kind: "library.pages", pages: [page(), page({ renderId: "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6", conversationId: missingConversationId, title: "Gone" })] })
      : ok());
    const view = harness(appSnapshot(fullLibrary, false), request);
    await user.click(screen.getByRole("tab", { name: "Pages" }));
    expect(sent(view.request, "library.pages.list")).toEqual([{ type: "library.pages.list", payload: {} }]);
    const grid = await screen.findByRole("list", { name: "Pages" });
    expect(within(grid).getByText("Treatment comparison")).toBeVisible();
    expect(within(grid).queryByText("Gone")).toBeNull();

    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(sent(view.request, "library.pages.list")).toHaveLength(2);

    await user.click(within(grid).getByRole("button", { name: /Treatment comparison/u }));
    const dialog = await screen.findByTestId("html-render-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Go to answer" }));
    expect(view.onOpenAnswer).toHaveBeenCalledWith({
      projectId: firstProjectId,
      conversationId: otherConversationId,
      turnId: "page-turn",
      messageId: "page-message",
    });
    expect(view.onOpenTurn).not.toHaveBeenCalled();
  });

  it("goes to the turn when a page has no message to land on", async () => {
    const user = userEvent.setup();
    const request = vi.fn<Request>(async () => result({ kind: "library.pages", pages: [page({ messageId: null })] }));
    const view = harness(appSnapshot(fullLibrary, false), request);
    await user.click(screen.getByRole("tab", { name: "Pages" }));
    await user.click(await screen.findByRole("button", { name: "Treatment comparison" }));
    await user.click(within(await screen.findByTestId("html-render-dialog")).getByRole("button", { name: "Go to answer" }));
    expect(view.onOpenTurn).toHaveBeenCalledWith({ conversationId: otherConversationId, turnId: "page-turn" });
    expect(view.onOpenAnswer).not.toHaveBeenCalled();
  });

  it("mounts sandboxed live previews only for visible pages, at most twelve at a time", async () => {
    const user = userEvent.setup();
    const observed = new Map<Element, IntersectionObserverCallback>();
    class FakeIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element): void { observed.set(element, this.callback); }
      unobserve(element: Element): void { observed.delete(element); }
      disconnect(): void { observed.clear(); }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const ids = Array.from({ length: 20 }, (_, index) => `0000000${String(index).padStart(2, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(-36));
    const pages = ids.map((renderId, index) => page({ renderId, title: `Page ${index + 1}` }));
    const request = vi.fn<Request>(async () => result({ kind: "library.pages", pages }));
    harness(appSnapshot(fullLibrary, false), request);
    await user.click(screen.getByRole("tab", { name: "Pages" }));
    await screen.findByText("Page 1");
    expect(screen.queryAllByTestId("library-page-preview")).toHaveLength(0);
    const cards = [...document.querySelectorAll<HTMLElement>(".library-page")];
    const intersect = (elements: HTMLElement[], isIntersecting: boolean): void => {
      act(() => {
        const callback = observed.get(elements[0]!)!;
        callback(elements.map((target) => ({
          target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
        }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
      });
    };
    intersect(cards.slice(0, 16), true);
    const frames = screen.getAllByTestId("library-page-preview");
    expect(frames).toHaveLength(12);
    for (const frame of frames) {
      expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(frame).toHaveAttribute("tabindex", "-1");
      expect(frame.closest(".library-page-preview")).toHaveAttribute("aria-hidden", "true");
      expect(frame.closest(".library-page-preview")).toHaveAttribute("inert");
      expect(frame.getAttribute("src")).toMatch(/:\/\/render\/[0-9a-f-]{36}#/u);
    }
    expect(cards[0]!.querySelector("[data-testid=library-page-preview]")).not.toBeNull();
    expect(cards[13]!.querySelector("[data-testid=library-page-preview]")).toBeNull();

    intersect(cards.slice(0, 6), false);
    expect(screen.getAllByTestId("library-page-preview")).toHaveLength(10);
    expect(cards[0]!.querySelector("[data-testid=library-page-preview]")).toBeNull();
    expect(cards[13]!.querySelector("[data-testid=library-page-preview]")).not.toBeNull();
  });

  it("keeps mounted previews stable and gives fully visible pages priority", () => {
    const ids = ["a", "b", "c", "d"];
    const ratios = new Map([["a", 0.25], ["b", 0.5], ["c", 1], ["d", 1]]);
    expect(choosePreviewSlots(ids, ratios, [], 2)).toEqual(["c", "d"]);
    expect(choosePreviewSlots(ids, ratios, ["a", "b"], 2)).toEqual(["c", "d"]);
    expect(choosePreviewSlots(ids, new Map([["a", 0.5], ["b", 0.75]]), ["a"], 2)).toEqual(["a", "b"]);
    expect(choosePreviewSlots(ids, new Map([["b", 0.75]]), ["a"], 2)).toEqual(["b"]);
  });

  it("gives a failed preview's slot to the next visible page", () => {
    const ids = ["a", "b", "c"];
    const ratios = new Map([["a", 1], ["b", 1], ["c", 0.5]]);
    expect(choosePreviewSlots(ids, ratios, [], 2)).toEqual(["a", "b"]);
    expect(choosePreviewSlots(ids, ratios, ["a", "b"], 2, new Set(["a"]))).toEqual(["b", "c"]);
  });

  it("frees the slot of a page whose preview is unavailable", async () => {
    const user = userEvent.setup();
    const observed = new Map<Element, IntersectionObserverCallback>();
    class FakeIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(element: Element): void { observed.set(element, this.callback); }
      unobserve(element: Element): void { observed.delete(element); }
      disconnect(): void { observed.clear(); }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const ids = Array.from({ length: 13 }, (_, index) => `0000000${String(index).padStart(2, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`.slice(-36));
    const pages = ids.map((renderId, index) => page({ renderId, title: `Page ${index + 1}` }));
    harness(appSnapshot(fullLibrary, false), vi.fn<Request>(async () => result({ kind: "library.pages", pages })));
    await user.click(screen.getByRole("tab", { name: "Pages" }));
    await screen.findByText("Page 1");
    const cards = [...document.querySelectorAll<HTMLElement>(".library-page")];
    act(() => {
      observed.get(cards[0]!)!(cards.map((target) => ({
        target, isIntersecting: true, intersectionRatio: 1,
      }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
    });
    expect(screen.getAllByTestId("library-page-preview")).toHaveLength(12);
    expect(cards[12]!.querySelector("[data-testid=library-page-preview]")).toBeNull();
    const failing = cards[0]!.querySelector<HTMLIFrameElement>("[data-testid=library-page-preview]")!;
    const frameWindow = { postMessage: vi.fn() };
    Object.defineProperty(failing, "contentWindow", { configurable: true, value: frameWindow });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "inertia-html-render:unavailable" },
        origin: "null",
        source: frameWindow as unknown as MessageEventSource,
      }));
    });
    expect(cards[0]!.querySelector("[data-testid=library-page-preview]")).toBeNull();
    expect(cards[12]!.querySelector("[data-testid=library-page-preview]")).not.toBeNull();
    expect(screen.getAllByTestId("library-page-preview")).toHaveLength(12);
  });

  it("explains an empty Pages tab", async () => {
    const user = userEvent.setup();
    const request = vi.fn<Request>(async () => result({ kind: "library.pages", pages: [] }));
    harness(appSnapshot(fullLibrary), request);
    await user.click(screen.getByRole("tab", { name: "Pages" }));
    expect(await screen.findByText("No pages yet")).toBeVisible();
  });
});
