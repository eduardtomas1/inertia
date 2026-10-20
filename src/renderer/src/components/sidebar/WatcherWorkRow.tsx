import clsx from "clsx";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Conversation } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { useWatcherDock } from "../../hooks/useWatcherDock";
import { watcherPresetName, watcherUnseenText } from "../../utils/watcherLinks";
import { ProviderBrandIcon } from "../ProviderBrandIcon";

function watcherRowState(link: WatcherLinkView | undefined): string | null {
  if (!link) return null;
  if (link.status === "waking") return "Checking";
  if (link.status === "paused") return "Paused";
  return null;
}

/** The thread actions a watcher row shares with every other Work row. */
export interface WatcherWorkRowMenu {
  open: boolean;
  /** The thread actions menu, rendered while it is open. */
  actions: ReactNode;
  /** A rename form replaces the row while the user renames the watcher. */
  renameForm: ReactNode | null;
  triggerRef: (node: HTMLButtonElement | null) => void;
  onOpen: (anchor: { x: number; y: number }) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

/**
 * A watcher listed directly under the chat it watches. It shares the parent's
 * section and collapse state, joins the Work tab's arrow-key order, and offers
 * the same thread actions (context menu, Shift+F10, drag to split view).
 */
export function WatcherWorkRow({
  conversation,
  parentTitle,
  link,
  active,
  statusLabel,
  menu,
  onActivate,
}: {
  conversation: Conversation;
  parentTitle: string;
  link: WatcherLinkView | undefined;
  active: boolean;
  statusLabel: string;
  menu: WatcherWorkRowMenu;
  onActivate: (conversation: Conversation) => void;
}): React.JSX.Element {
  const name = link ? `Watcher · ${watcherPresetName(link.preset)}` : conversation.title;
  const state = watcherRowState(link);
  const dock = useWatcherDock(link?.watchedConversationId ?? null);
  const unseen = link ? watcherUnseenText(link, dock) : null;
  return (
    <div
      className={clsx("activity-thread is-watcher", active && "is-active", menu.open && "has-open-menu")}
      role="listitem"
      data-sidebar-motion-id={`watcher:${conversation.id}`}
      data-watcher-status={link?.status}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        event.preventDefault();
        menu.onOpen({ x: event.clientX, y: event.clientY });
      }}
    >
      {menu.renameForm ?? (
        <button
          type="button"
          ref={menu.triggerRef}
          className="activity-thread-select watcher-work-row"
          data-sidebar-nav
          data-work-focus-id={`watcher:${conversation.id}`}
          aria-current={active ? "page" : undefined}
          aria-label={[`${name}, watching ${parentTitle}`, unseen, state ?? statusLabel].filter(Boolean).join(", ")}
          aria-description="Right-click or press Shift+F10 for thread actions."
          aria-haspopup="menu"
          aria-expanded={menu.open}
          aria-controls={menu.open ? `conversation-actions-${conversation.id}` : undefined}
          onPointerDown={menu.onPointerDown}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            menu.onOpen({ x: bounds.right, y: bounds.top });
          }}
          onClick={() => onActivate(conversation)}
        >
          <span className="watcher-work-row-line">
            <span className="watcher-work-row-branch" aria-hidden="true" />
            <span className="activity-thread-provider" aria-hidden="true">
              <ProviderBrandIcon providerId={conversation.providerId} decorative size={14} />
            </span>
            <span className="watcher-work-row-title">{name}</span>
            {unseen && <span className="watcher-work-row-new">{unseen}</span>}
            {state && <span className="watcher-work-row-state">{state}</span>}
          </span>
        </button>
      )}
      {menu.open && menu.actions}
    </div>
  );
}
