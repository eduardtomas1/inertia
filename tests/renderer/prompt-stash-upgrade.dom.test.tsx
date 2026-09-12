import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/src/components/composer/Composer";
import { addPromptStashEntry, readPromptStash, writePromptStash } from "../../src/renderer/src/utils/promptStash";
import { composerProps, conversation } from "./composer-fixtures";

const bridge = window.inertia;

afterEach(async () => {
  await vi.dynamicImportSettled();
  window.localStorage.clear();
  window.inertia = bridge;
});

it("keeps a prompt saved by v0.0.54 accessible after upgrading", async () => {
  const chat = conversation("upgraded-chat");
  const text = "My unfinished v54 release checklist";
  // v0.0.54 stored the same validated payload under one global key.
  const entries = addPromptStashEntry([], text, chat.modelSelection);
  writePromptStash(window.localStorage, entries);
  render(<Composer {...composerProps(chat)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Scratch prompts" }));
  expect(await screen.findByText(text)).toBeInTheDocument();
  // The upgrade must not silently assign a legacy prompt to this chat.
  expect(readPromptStash(window.localStorage, chat.id)).toEqual([]);
  expect(readPromptStash(window.localStorage)).toEqual(entries);
});

it.each([true, false, "reject"])("copies legacy text explicitly without changing either chat or stored prompts (clipboard: %s)", async (outcome) => {
  const chat = conversation("upgraded-chat");
  const entries = addPromptStashEntry([], "Keep my old prompt\nwith its full text", chat.modelSelection);
  writePromptStash(window.localStorage, entries);
  const copyText = vi.fn(async () => {
    if (outcome === "reject") throw new Error("Unavailable");
    return outcome === true;
  });
  window.inertia = { ...bridge, copyText };
  render(<Composer {...composerProps(chat)} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Unfinished current draft" } });
  fireEvent.click(await screen.findByRole("button", { name: "Scratch prompts" }));
  expect(copyText).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Keep my old prompt/u }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(outcome === true ? "Copied." : "Could not copy"));
  expect(copyText).toHaveBeenCalledExactlyOnceWith(entries[0]!.content);
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Unfinished current draft");
  expect(readPromptStash(window.localStorage)).toEqual(entries);
  expect(readPromptStash(window.localStorage, chat.id)).toEqual([]);
});
