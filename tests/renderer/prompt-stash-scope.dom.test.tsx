import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/src/components/composer/Composer";
import { useComposerPromptStash } from "../../src/renderer/src/components/composer/useComposerPromptStash";
import { addPromptStashEntry, movePromptStash, promptStashStorageKey, readPromptStash, writePromptStash } from "../../src/renderer/src/utils/promptStash";
import { composerProps, conversation } from "./composer-fixtures";

afterEach(async () => {
  await vi.dynamicImportSettled();
  window.localStorage.clear();
});

describe("chat-owned prompt stash", () => {
  it("never shows the previous chat's entries on the first render after a switch", () => {
    const first = conversation("first-chat");
    const second = conversation("second-chat");
    writePromptStash(window.localStorage, addPromptStashEntry([], "Only first", first.modelSelection), first.id);
    writePromptStash(window.localStorage, addPromptStashEntry([], "Only second", second.modelSelection), second.id);
    const renders: string[][] = [];
    const hook = renderHook(({ id }) => {
      const result = useComposerPromptStash(true, id);
      renders.push(result[0].map(({ content }) => content));
      return result;
    }, { initialProps: { id: first.id } });
    expect(hook.result.current[0][0]?.content).toBe("Only first");
    renders.length = 0;
    hook.rerender({ id: second.id });
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every((entries) => !entries.includes("Only first"))).toBe(true);
    expect(hook.result.current[0][0]?.content).toBe("Only second");
    act(() => {
      writePromptStash(window.localStorage, [], first.id);
      window.dispatchEvent(new StorageEvent("storage", { key: promptStashStorageKey(first.id) }));
    });
    expect(hook.result.current[0][0]?.content).toBe("Only second");
    act(() => {
      writePromptStash(window.localStorage, [], second.id);
      window.dispatchEvent(new StorageEvent("storage", { key: promptStashStorageKey(second.id) }));
    });
    expect(hook.result.current[0]).toEqual([]);
  });

  it("saves, hides in another chat using the same model, and restores only in its original composer", async () => {
    const first = conversation("stash-source");
    const second = conversation("stash-other");
    const view = render(<Composer {...composerProps(first)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "My source-chat draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Scratch prompts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Save current prompt/u }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(readPromptStash(window.localStorage, first.id)[0]?.content).toBe("My source-chat draft");
    view.rerender(<Composer {...composerProps(second)} />);
    fireEvent.click(screen.getByRole("button", { name: "Scratch prompts" }));
    expect(screen.queryByText("My source-chat draft")).not.toBeInTheDocument();
    expect(readPromptStash(window.localStorage, second.id)).toEqual([]);
    view.rerender(<Composer {...composerProps(first)} />);
    const button = screen.getByRole("button", { name: "Scratch prompts, 1 saved" });
    if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: /^My source-chat draft/u }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("My source-chat draft");
    expect(readPromptStash(window.localStorage, first.id)).toEqual([]);
  });

  it("keeps ownerless legacy entries private and migrates only an explicitly materialized draft", () => {
    const model = conversation("draft").modelSelection;
    const entries = addPromptStashEntry([], "Saved draft", model);
    writePromptStash(window.localStorage, entries);
    const hook = renderHook(() => useComposerPromptStash(true, "unrelated-chat"));
    expect(hook.result.current[0]).toEqual([]);
    expect(readPromptStash(window.localStorage)).toEqual(entries);
    writePromptStash(window.localStorage, entries, "draft");
    expect(movePromptStash(window.localStorage, "draft", "created-chat")).toBe(true);
    expect(readPromptStash(window.localStorage, "created-chat")).toEqual(entries);
    expect(readPromptStash(window.localStorage, "draft")).toEqual([]);
    expect(readPromptStash(window.localStorage, "unrelated-chat")).toEqual([]);
  });
});
