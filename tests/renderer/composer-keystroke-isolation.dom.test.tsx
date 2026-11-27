import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toolbarRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/renderer/src/components/composer/ComposerToolbar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/composer/ComposerToolbar")>();
  const { memo } = await import("react");
  type ToolbarFn = (props: object) => ReturnType<typeof actual.ComposerToolbar>;
  const target = actual.ComposerToolbar as unknown as
    | { $$typeof?: symbol; type?: ToolbarFn }
    | ToolbarFn;
  const inner: ToolbarFn = typeof target === "function" ? target : target.type!;
  const wrapped: ToolbarFn = (props: object) => {
    toolbarRenders.count += 1;
    return inner(props);
  };
  return {
    ...actual,
    ComposerToolbar: typeof target === "function" ? wrapped : memo(wrapped),
  };
});

import { Composer } from "../../src/renderer/src/components/composer/Composer";
import { composerProps, conversation, routedProvider } from "./composer-fixtures";

afterEach(() => {
  cleanup();
  toolbarRenders.count = 0;
  window.localStorage.clear();
});

describe("Composer keystroke isolation", () => {
  it("does not re-render ComposerToolbar while typing or moving the caret", async () => {
    const active = conversation("keystroke-isolation");
    render(
      <Composer
        {...composerProps(active, {
          providers: [routedProvider],
        })}
      />,
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const textarea = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    // Wait past initial mount; reset counter right before typing.
    toolbarRenders.count = 0;

    let draft = "";
    for (let index = 0; index < 60; index += 1) {
      draft += index % 10 === 9 ? " " : "a";
      act(() => {
        fireEvent.change(textarea, { target: { value: draft } });
      });
    }
    for (let caret = 0; caret < 20; caret += 1) {
      act(() => {
        textarea.selectionStart = caret;
        textarea.selectionEnd = caret;
        fireEvent.select(textarea);
      });
    }

    // Only the empty -> non-empty transition changes canStashPrompt / awaitingInput / primaryAction.
    expect(toolbarRenders.count).toBeLessThanOrEqual(2);
    expect(textarea.value).toBe(draft);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  });
});
