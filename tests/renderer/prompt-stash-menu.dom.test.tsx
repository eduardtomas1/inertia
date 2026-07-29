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
      name: "Prompt stash, 1 saved",
    }));
    expect(screen.getByRole("menu", { name: "Prompt stash" }))
      .toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Saved prompts" }))
      .toBeInTheDocument();

    const stash = screen.getByRole("menuitem", {
      name: /Stash current prompt Remove attachments before stashing text/u,
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
});
