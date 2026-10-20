import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationActionsMenu } from "../../src/renderer/src/components/ConversationActionsMenu";
import { sidebarThreadView } from "../../src/renderer/src/utils/sidebarModel";
import type { Conversation, Initiative } from "../../src/shared/contracts";
import { conversation } from "./composer-fixtures";

function initiative(id: string, name: string, status: Initiative["status"] = "active"): Initiative {
  return {
    id, name, color: "blue", status, brief: "", briefRevision: 0, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0, revision: 1,
    createdAt: "2026-10-19T08:00:00.000Z", updatedAt: "2026-10-19T08:00:00.000Z",
  };
}

const checkout = initiative("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Checkout");
const docs = initiative("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Docs");
const shipped = initiative("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Shipped", "done");
const shelved = initiative("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Shelved", "archived");

function renderMenu(chat: Conversation, overrides: Partial<React.ComponentProps<typeof ConversationActionsMenu>> = {}) {
  const props = {
    onDismiss: vi.fn(),
    onAssignInitiative: vi.fn(),
    onCreateInitiative: vi.fn(),
  };
  render(
    <ConversationActionsMenu
      activeConversationId={null}
      activity
      conversation={chat}
      runs={[]}
      splitConversationIds={new Set()}
      thread={sidebarThreadView(chat, null)}
      onAcknowledgeRun={vi.fn()}
      onArchiveConversation={vi.fn()}
      onCloseConversationSplit={vi.fn()}
      onDeleteConversation={vi.fn()}
      onDismissRun={vi.fn()}
      onOpenConversationInSplit={vi.fn()}
      onPinConversation={vi.fn()}
      onRestoreConversation={vi.fn()}
      onSetPopover={vi.fn()}
      onSettleConversation={vi.fn()}
      onSnoozeConversation={vi.fn()}
      onStartRename={vi.fn()}
      initiatives={[checkout, docs, shipped, shelved]}
      {...props}
      {...overrides}
    />,
  );
  return props;
}

describe("Move to initiative in chat actions", () => {
  it("opens with the keyboard and lists only active initiatives plus New initiative…", async () => {
    const chat = conversation("loose");
    const props = renderMenu(chat);
    const menu = screen.getByRole("menu", { name: "Thread actions for loose" });
    const trigger = within(menu).getByRole("menuitem", { name: "Move to initiative" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const submenu = screen.getByRole("menu", { name: "Move to initiative" });
    await waitFor(() => expect(within(submenu).getByRole("menuitem", { name: "Checkout" })).toHaveFocus());
    expect(within(submenu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Checkout", "Docs", "New initiative…"]);
    fireEvent.keyDown(submenu, { key: "ArrowDown" });
    expect(within(submenu).getByRole("menuitem", { name: "Docs" })).toHaveFocus();
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Docs" }));
    expect(props.onAssignInitiative).toHaveBeenCalledExactlyOnceWith(chat, docs.id);
    expect(props.onDismiss).toHaveBeenCalledWith("selection");
  });

  it("offers removal for a member and hides its current initiative", () => {
    const chat = { ...conversation("member"), initiativeId: checkout.id };
    const props = renderMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to initiative" }));
    const submenu = screen.getByRole("menu", { name: "Move to initiative" });
    expect(within(submenu).queryByRole("menuitem", { name: "Checkout" })).not.toBeInTheDocument();
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Remove from Checkout" }));
    expect(props.onAssignInitiative).toHaveBeenCalledExactlyOnceWith(chat, null);
  });

  it("still lets a chat leave an archived initiative", () => {
    const chat = { ...conversation("shelved-member"), initiativeId: shelved.id };
    const props = renderMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to initiative" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Move to initiative" }))
      .getByRole("menuitem", { name: "Remove from Shelved" }));
    expect(props.onAssignInitiative).toHaveBeenCalledExactlyOnceWith(chat, null);
  });

  it("starts a new initiative for the chat without restoring focus to the closed menu", () => {
    const chat = conversation("loose");
    const props = renderMenu(chat);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to initiative" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Move to initiative" }))
      .getByRole("menuitem", { name: "New initiative…" }));
    expect(props.onCreateInitiative).toHaveBeenCalledExactlyOnceWith(chat);
    expect(props.onDismiss).toHaveBeenCalledWith("context-change");
  });

  it("is absent where initiatives cannot be changed", () => {
    renderMenu(conversation("detached"), { onAssignInitiative: undefined });
    expect(screen.queryByRole("menuitem", { name: "Move to initiative" })).not.toBeInTheDocument();
  });
});
