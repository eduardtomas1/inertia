import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InitiativePicker } from "../../src/renderer/src/components/composer/InitiativePicker";
import { InitiativeCreateHost } from "../../src/renderer/src/components/initiatives/InitiativeCreateHost";
import { loadInitiativeCreateDialog } from "../../src/renderer/src/components/lazySurfaceLoaders";
import { newChatInitiativePickerProps } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import type { NewChatInitiativePicker } from "../../src/renderer/src/components/composer/types";
import {
  closeNewInitiativeRequest,
  useNewInitiativeRequest,
} from "../../src/renderer/src/utils/initiativeDialog";
import type { Initiative } from "../../src/shared/contracts";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";

const checkout: Initiative = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Checkout redesign",
  color: "teal",
  status: "active",
  brief: "",
  preferences: defaultInitiativePreferences(), briefRevision: 0, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0,
  revision: 1,
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T08:00:00.000Z",
};
const docs: Initiative = { ...checkout, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Docs", createdAt: "2026-10-19T09:00:00.000Z" };
const shipped: Initiative = { ...checkout, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Shipped", status: "done" };
const shelved: Initiative = { ...checkout, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Shelved", status: "archived" };

const observed: { request: ReturnType<typeof useNewInitiativeRequest> } = { request: null };
function RequestProbe(): null {
  const request = useNewInitiativeRequest();
  useEffect(() => { observed.request = request; }, [request]);
  return null;
}

function renderPicker(overrides: Partial<NewChatInitiativePicker> = {}) {
  const onChange = vi.fn();
  const picker: NewChatInitiativePicker = {
    initiatives: [docs, shipped, checkout, shelved],
    selectedId: null,
    disabled: false,
    onChange,
    ...overrides,
  };
  const view = render(<><InitiativePicker picker={picker} /><RequestProbe /></>);
  return { ...view, onChange, picker };
}

afterEach(() => {
  act(() => closeNewInitiativeRequest());
  observed.request = null;
});

describe("new chat initiative picker", () => {
  it("defaults to No initiative and lists only active initiatives in creation order", async () => {
    renderPicker();
    const trigger = screen.getByRole("button", { name: "Initiative: No initiative" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Choose initiative" });
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent))
      .toEqual(["No initiative", "Checkout redesign", "Docs"]);
    expect(within(menu).getByRole("menuitemradio", { name: "No initiative" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: "No initiative" })).toHaveFocus());
    expect(within(menu).getByRole("menuitem", { name: "New initiative…" })).toBeInTheDocument();
  });

  it("chooses an initiative with the keyboard and returns focus to the trigger", async () => {
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("button", { name: "Initiative: No initiative" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Choose initiative" });
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: "No initiative" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitemradio", { name: "Checkout redesign" })).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(checkout.id);
    expect(screen.queryByRole("menu", { name: "Choose initiative" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows the selected initiative and can clear it", () => {
    const { onChange } = renderPicker({ selectedId: docs.id });
    const trigger = screen.getByRole("button", { name: "Initiative: Docs" });
    expect(trigger).toHaveTextContent("Docs");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Choose initiative" });
    expect(within(menu).getByRole("menuitemradio", { name: "Docs" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "No initiative" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("treats a selection that is no longer active as No initiative", () => {
    renderPicker({ selectedId: shipped.id });
    expect(screen.getByRole("button", { name: "Initiative: No initiative" })).toBeInTheDocument();
  });

  it("closes on Escape without changing the choice", async () => {
    const { onChange } = renderPicker();
    const trigger = screen.getByRole("button", { name: "Initiative: No initiative" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Choose initiative" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("asks the app for a new initiative and selects it once created", () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Initiative: No initiative" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New initiative…" }));
    expect(screen.queryByRole("menu", { name: "Choose initiative" })).not.toBeInTheDocument();
    expect(observed.request).not.toBeNull();
    expect(observed.request?.conversationId).toBeUndefined();
    act(() => observed.request?.onCreated?.(docs.id));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(docs.id);
  });

  it("returns focus to the picker after the New initiative dialog closes", async () => {
    await loadInitiativeCreateDialog();
    renderPicker();
    render(<InitiativeCreateHost snapshot={null} run={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Initiative: No initiative" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = screen.getByRole("menuitem", { name: "New initiative…" });
    item.focus();
    fireEvent.click(item);
    expect(observed.request?.returnFocus).toBe(trigger);
    const dialog = await screen.findByRole("dialog", { name: "New initiative" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("appears in the new-chat composer only once an initiative exists", () => {
    const onChange = vi.fn();
    expect(newChatInitiativePickerProps(undefined, null, false, onChange)).toEqual({});
    expect(newChatInitiativePickerProps([], null, false, onChange)).toEqual({});
    expect(newChatInitiativePickerProps([checkout], null, false, undefined)).toEqual({});
    // Any initiative counts, so the picker can still offer New initiative….
    expect(newChatInitiativePickerProps([shelved], docs.id, true, onChange)).toEqual({
      newChatInitiativePicker: { initiatives: [shelved], selectedId: docs.id, disabled: true, onChange },
    });
  });

  it("stays closed while disabled", () => {
    renderPicker({ disabled: true });
    const trigger = screen.getByRole("button", { name: "Initiative: No initiative" });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
