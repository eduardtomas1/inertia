import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LibraryAnswerContext,
  savedAnswersByMessage,
  type LibraryAnswerController,
} from "../../src/renderer/src/components/library/LibraryAnswerContext";
import { LibrarySaveButton } from "../../src/renderer/src/components/library/LibrarySaveButton";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ServerEvent } from "../../src/shared/contracts";
import type { LibrarySnapshot } from "../../src/shared/library";
import {
  category,
  createdCategoryId,
  library,
  recipesId,
  researchId,
  result,
  savedAnswer,
} from "./library-fixtures";
import { conversationId, ok, sent, stubMatchMedia } from "./tasks-fixtures";

type Request = (command: CommandWithoutId) => Promise<ServerEvent>;

const LAST_CATEGORY_KEY = "inertia:library:last-category:v1";
const research = category(researchId, "Research");
const recipes = category(recipesId, "Recipes");
const answer = { id: "answer-message", conversationId };
const stored = savedAnswer({ id: "f7f7f7f7-f7f7-4f7f-8f7f-f7f7f7f7f7f7", messageId: answer.id, turnId: "turn-final", categoryId: researchId });

function harness(initial: LibrarySnapshot | null, request?: Request) {
  const mock = vi.fn<Request>(request ?? (async (command) => command.type === "library.answer.save"
    ? result({ kind: "library.answer", savedAnswer: { ...stored, categoryId: command.payload.categoryId } })
    : ok()));
  const onError = vi.fn();
  const controller = (value: LibrarySnapshot | null, online = true): LibraryAnswerController => ({
    library: value,
    savedByMessageId: savedAnswersByMessage(value),
    online,
    request: mock,
    onError,
  });
  const tree = (value: LibrarySnapshot | null, online?: boolean) => (
    <LibraryAnswerContext.Provider value={controller(value, online)}>
      <footer className="turn-meta">
        <LibrarySaveButton answer={answer} turnId="turn-final" />
      </footer>
    </LibraryAnswerContext.Provider>
  );
  const view = render(tree(initial));
  return {
    ...view,
    request: mock,
    onError,
    update(next: LibrarySnapshot | null, online?: boolean) {
      view.rerender(tree(next, online));
    },
  };
}

beforeEach(() => {
  stubMatchMedia();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Save to Library", () => {
  it("stays out of the way when the Library is unavailable", () => {
    harness(null);
    expect(screen.queryByRole("button", { name: /Library/u })).toBeNull();
  });

  it("saves into the last used category and opens the Saved to menu", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(LAST_CATEGORY_KEY, recipesId);
    const view = harness(library([research, recipes], []));
    const toggle = screen.getByRole("button", { name: "Save to Library" });
    expect(toggle).toHaveAttribute("aria-haspopup", "menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(sent(view.request, "library.answer.save")).toEqual([{
      type: "library.answer.save",
      payload: { conversationId, turnId: "turn-final", messageId: answer.id, categoryId: recipesId },
    }]);
    const menu = await screen.findByRole("menu", { name: "Saved to" });
    expect(menu).toHaveTextContent("Saved to");
    expect(within(menu).getByRole("menuitemradio", { name: "Recipes" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "Unsorted" })).toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitem", { name: "Remove from Library" })).toHaveClass("is-danger");
    expect(screen.getByRole("button", { name: "Saved to Library" })).toHaveAttribute("aria-expanded", "true");
  });

  it("falls back to Unsorted when the remembered category is gone", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(LAST_CATEGORY_KEY, "00000000-0000-4000-8000-000000000000");
    const view = harness(library([research], []));
    await user.click(screen.getByRole("button", { name: "Save to Library" }));
    expect(sent(view.request, "library.answer.save")[0]!.payload.categoryId).toBeNull();
  });

  it("shows what the Library already holds when a stale window saves again", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(LAST_CATEGORY_KEY, recipesId);
    const view = harness(library([research, recipes], []), async (command) => command.type === "library.answer.save"
      ? result({ kind: "library.answer", savedAnswer: stored })
      : ok());
    await user.click(screen.getByRole("button", { name: "Save to Library" }));
    const menu = await screen.findByRole("menu", { name: "Saved to" });
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: "Research" }))
      .toHaveAttribute("aria-checked", "true"));
    await user.click(within(menu).getByRole("menuitemradio", { name: "Research" }));
    expect(sent(view.request, "library.answer.update")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Saved to Library" }));
    await user.click(within(await screen.findByRole("menu", { name: "Saved to" })).getByRole("menuitemradio", { name: "Recipes" }));
    await waitFor(() => expect(sent(view.request, "library.answer.update")).toEqual([
      { type: "library.answer.update", payload: { savedAnswerId: stored.id, categoryId: recipesId } },
    ]));
  });

  it("shows a saved answer as saved and moves it to another category", async () => {
    const user = userEvent.setup();
    const view = harness(library([research, recipes], [stored]));
    const toggle = screen.getByRole("button", { name: "Saved to Library" });
    expect(toggle).toHaveClass("is-saved");

    await user.click(toggle);
    expect(sent(view.request, "library.answer.save")).toEqual([]);
    const menu = await screen.findByRole("menu", { name: "Saved to" });
    expect(within(menu).getByRole("menuitemradio", { name: "Research" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemradio", { name: "Recipes" }));

    await waitFor(() => expect(sent(view.request, "library.answer.update")).toEqual([{
      type: "library.answer.update",
      payload: { savedAnswerId: stored.id, categoryId: recipesId },
    }]));
    expect(window.localStorage.getItem(LAST_CATEGORY_KEY)).toBe(recipesId);
    expect(screen.queryByRole("menu", { name: "Saved to" })).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("removes the answer from the Library", async () => {
    const user = userEvent.setup();
    const view = harness(library([research], [stored]));
    await user.click(screen.getByRole("button", { name: "Saved to Library" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));
    await waitFor(() => expect(sent(view.request, "library.answer.remove")).toEqual([
      { type: "library.answer.remove", payload: { savedAnswerId: stored.id } },
    ]));
    view.update(library([research], []));
    expect(screen.getByRole("button", { name: "Save to Library" })).not.toHaveClass("is-saved");
  });

  it("creates a category from the menu and files the answer there", async () => {
    const user = userEvent.setup();
    const view = harness(library([research], [stored]), async (command) => command.type === "library.category.create"
      ? result({ kind: "library.category", category: category(createdCategoryId, "Reading list") })
      : ok());
    await user.click(screen.getByRole("button", { name: "Saved to Library" }));
    await user.click(await screen.findByRole("menuitem", { name: "New category…" }));
    const input = screen.getByRole("textbox", { name: "New category name" });
    expect(input).toHaveFocus();
    await user.type(input, "Reading list{Enter}");
    await waitFor(() => expect(sent(view.request, "library.answer.update")).toEqual([
      { type: "library.answer.update", payload: { savedAnswerId: stored.id, categoryId: createdCategoryId } },
    ]));
    expect(sent(view.request, "library.category.create")).toEqual([
      { type: "library.category.create", payload: { name: "Reading list" } },
    ]);
    expect(window.localStorage.getItem(LAST_CATEGORY_KEY)).toBe(createdCategoryId);
  });

  it("explains a refused category inside the menu and keeps it open", async () => {
    const user = userEvent.setup();
    harness(library([research], [stored]), async () => { throw new Error("A category with that name already exists."); });
    await user.click(screen.getByRole("button", { name: "Saved to Library" }));
    await user.click(await screen.findByRole("menuitem", { name: "New category…" }));
    await user.type(screen.getByRole("textbox", { name: "New category name" }), "Research{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("A category with that name already exists.");
    expect(await screen.findByRole("menu", { name: "Saved to" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("menuitem", { name: "New category…" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Saved to" })).toBeNull();
  });

  it("reports a failed save and closes the menu", async () => {
    const user = userEvent.setup();
    const view = harness(library([], []), async () => { throw new Error("Only a finished answer can be saved."); });
    await user.click(screen.getByRole("button", { name: "Save to Library" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Only a finished answer can be saved."));
    expect(screen.queryByRole("menu", { name: "Saved to" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save to Library" })).toBeVisible();
  });

  it("is disabled while the runtime is offline", () => {
    const view = harness(library([], []));
    view.update(library([], []), false);
    expect(screen.getByRole("button", { name: "Save to Library" })).toBeDisabled();
  });
});
