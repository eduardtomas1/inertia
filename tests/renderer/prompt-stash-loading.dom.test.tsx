import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type LegacyPromptStash from "../../src/renderer/src/components/composer/LegacyPromptStash";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptStashMenu } from "../../src/renderer/src/components/composer/PromptStashMenu";
import { useComposerMenus } from "../../src/renderer/src/components/composer/useComposerMenus";
import { addPromptStashEntry, writePromptStash } from "../../src/renderer/src/utils/promptStash";
import { conversation } from "./composer-fixtures";

const loading = vi.hoisted(() => ({ promise: Promise.resolve(), release: () => {}, pending: false }));
vi.mock("../../src/renderer/src/components/composer/LegacyPromptStash", async (original) => {
  const module = await original<{ default: typeof LegacyPromptStash }>();
  return { default: (props: Parameters<typeof LegacyPromptStash>[0]) => {
    if (loading.pending) throw loading.promise;
    return <module.default {...props} />;
  } };
});

function Harness(): React.JSX.Element {
  const controller = useComposerMenus();
  return <><button>Outside</button><PromptStashMenu entries={[]} canStash blockedReason={null}
    restoreBlockedReason={() => null} menuController={controller} onStash={vi.fn()}
    onRestore={vi.fn()} onRemove={vi.fn()} onSetRecurrence={vi.fn()} /></>;
}

beforeEach(() => {
  loading.pending = true;
  loading.promise = new Promise<void>((resolve) => { loading.release = () => { loading.pending = false; resolve(); }; });
  writePromptStash(localStorage, addPromptStashEntry([], "An earlier prompt", conversation("chat").modelSelection));
});
afterEach(async () => { await act(async () => { loading.release(); await vi.dynamicImportSettled(); }); localStorage.clear(); });

it.each(["ready", "navigate", "outside", "dismiss"])("preserves ArrowUp's pending edge only until user intent changes (%s)", async (action) => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Scratch prompts" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  const placeholder = await screen.findByRole("menuitem", { name: "Loading earlier prompts…" });
  await waitFor(() => expect(placeholder).toHaveFocus());
  if (action === "navigate") fireEvent.keyDown(placeholder, { key: "ArrowDown" });
  if (action === "outside") screen.getByRole("button", { name: "Outside" }).focus();
  if (action === "dismiss") fireEvent.keyDown(placeholder, { key: "Escape" });
  const focused = document.activeElement;
  await act(async () => { loading.release(); });
  if (action === "ready") await waitFor(() => expect(screen.getByRole("menuitem", { name: /An earlier prompt/ })).toHaveFocus());
  else if (action === "dismiss") await waitFor(() => expect(trigger).toHaveFocus());
  else expect(document.activeElement).toBe(focused);
});
