import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PromptStashMenu,
} from "../../src/renderer/src/components/composer/PromptStashMenu";
import {
  useComposerMenus,
} from "../../src/renderer/src/components/composer/useComposerMenus";
import type {
  PromptStashEntry,
} from "../../src/renderer/src/utils/promptStash";

const entry: PromptStashEntry = {
  id: "saved-one",
  content: "Inspect the provider route before editing.",
  createdAt: "2026-07-29T10:00:00.000Z",
  route: {
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    modelId: "gpt-5.6",
    reasoningEffort: "xhigh",
  },
};

function Harness({
  onStash,
  onRestore,
  onRemove,
}: {
  onStash: () => void;
  onRestore: (value: PromptStashEntry) => void;
  onRemove: (entryId: string) => void;
}): React.JSX.Element {
  const menuController = useComposerMenus();
  return (
    <PromptStashMenu
      entries={[entry]}
      canStash={false}
      blockedReason="Remove attachments before stashing text"
      restoreBlockedReason={() => "This route is not available"}
      menuController={menuController}
      onStash={onStash}
      onRestore={onRestore}
      onRemove={onRemove}
      onSetRecurrence={vi.fn()}
    />
  );
}

describe("PromptStashMenu", () => {
  it("keeps unavailable actions focusable with their reason and labels deletes per entry", () => {
    const onStash = vi.fn();
    const onRestore = vi.fn();
    const onRemove = vi.fn();
    render(
      <Harness
        onStash={onStash}
        onRestore={onRestore}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Scratch prompts, 1 saved",
    }));
    expect(screen.getByRole("menu", { name: "Scratch prompts" }))
      .toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Saved scratch prompts" }))
      .toBeInTheDocument();

    const stash = screen.getByRole("menuitem", {
      name: /Save current prompt Remove attachments before stashing text/u,
    });
    expect(stash).toHaveAttribute("aria-disabled", "true");
    expect(stash).not.toBeDisabled();
    stash.focus();
    expect(stash).toHaveFocus();
    fireEvent.click(stash);
    expect(onStash).not.toHaveBeenCalled();

    const restore = screen.getByRole("menuitem", {
      name: /^Inspect the provider route before editing.*This route is not available/u,
    });
    expect(restore).toHaveAttribute("aria-disabled", "true");
    expect(restore).toHaveAttribute(
      "title",
      "This route is not available",
    );
    restore.focus();
    expect(restore).toHaveFocus();
    fireEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();

    const remove = screen.getByRole("menuitem", {
      name: "Delete saved prompt: Inspect the provider route before editing.",
    });
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith(entry.id);
  });

  it("keeps an unbroken saved prompt inside its bounded preview", () => {
    const longEntry: PromptStashEntry = {
      ...entry,
      id: "saved-long",
      content: `Inspect-${"provider-route-".repeat(40)}`,
    };
    function LongEntryHarness(): React.JSX.Element {
      const controller = useComposerMenus();
      return (
        <PromptStashMenu
          entries={[longEntry]}
          canStash
          blockedReason={null}
          restoreBlockedReason={() => null}
          menuController={controller}
          onStash={vi.fn()}
          onRestore={vi.fn()}
          onRemove={vi.fn()}
          onSetRecurrence={vi.fn()}
        />
      );
    }
    render(<LongEntryHarness />);

    fireEvent.click(screen.getByRole("button", {
      name: "Scratch prompts, 1 saved",
    }));
    const restore = screen.getByRole("menuitem", {
      name: new RegExp(`^${longEntry.content}`, "u"),
    });
    expect(restore).toHaveAttribute("title", longEntry.content);
    expect(
      restore.querySelector(".prompt-stash-entry-copy"),
    ).toHaveClass("prompt-stash-entry-copy");
    expect(
      restore.querySelector(".prompt-stash-entry-preview"),
    ).toHaveTextContent(longEntry.content);
  });
});
