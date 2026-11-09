import { afterEach, describe, expect, it } from "vitest";

import { focusNewChatComposer } from "../../src/renderer/src/utils/focusNewChatComposer";

function mountComposer(): HTMLTextAreaElement {
  const pane = document.createElement("div");
  pane.id = "primary-conversation-pane";
  const editor = document.createElement("textarea");
  editor.setAttribute("aria-label", "Message");
  pane.append(editor);
  document.body.append(pane);
  return editor;
}

const frames = (count: number) => new Promise<void>((resolve) => {
  const step = (remaining: number) => {
    if (remaining === 0) resolve();
    else requestAnimationFrame(() => step(remaining - 1));
  };
  step(count);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("focusing the composer of a new chat", () => {
  it("puts the caret in the composer, including one that mounts a few frames later", async () => {
    focusNewChatComposer();
    await frames(3);
    const editor = mountComposer();
    await frames(3);
    expect(document.activeElement).toBe(editor);
  });

  it("waits for a closing palette and leaves a dialog that stays open alone", async () => {
    const editor = mountComposer();
    const palette = document.createElement("div");
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-modal", "true");
    document.body.append(palette);
    focusNewChatComposer();
    await frames(3);
    expect(document.activeElement).not.toBe(editor);
    palette.remove();
    await frames(3);
    expect(document.activeElement).toBe(editor);

    editor.blur();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    focusNewChatComposer();
    await new Promise((resolve) => setTimeout(resolve, 900));
    dialog.remove();
    await frames(3);
    expect(document.activeElement).not.toBe(editor);
  });

  it("never takes the caret from another field the user is typing in", async () => {
    const editor = mountComposer();
    const rename = document.createElement("input");
    document.body.append(rename);
    rename.focus();
    focusNewChatComposer();
    await frames(3);
    expect(document.activeElement).toBe(rename);
    expect(document.activeElement).not.toBe(editor);
  });
});
