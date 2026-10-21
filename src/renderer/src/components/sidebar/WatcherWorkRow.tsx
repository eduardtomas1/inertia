import clsx from "clsx";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Conversation } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { useWatcherDock } from "../../hooks/useWatcherDock";
import { watcherRowName, watcherUnseenText } from "../../utils/watcherLinks";
import { ProviderBrandIcon } from "../ProviderBrandIcon";

function watcherRowState(link: WatcherLinkView | undefined): string | null {
  if (!link) return null;
  if (link.status === "waking") return "Checking";
  if (link.status === "paused") return "Paused";
  return null;
}

interface WatcherWorkRowMenu {
  open: boolean;
  actions: ReactNode;
  renameForm: ReactNode | null;
  triggerRef: (node: HTMLButtonElement | null) => void;
  onOpen: (anchor: { x: number; y: number }) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function WatcherWorkRow({
  conversation,
  parentTitle,
  link,
  position,
  setSize,
  active,
  statusLabel,
  menu,
  onActivate,
}: {
  conversation: Conversation;
  parentTitle: string;
  link: WatcherLinkView | undefined;
  position: number;
  setSize: number;
  active: boolean;
  statusLabel: string;
  menu: WatcherWorkRowMenu;
  onActivate: (conversation: Conversation) => void;
}): React.JSX.Element {
  const name = link ? watcherRowName(link.preset) : conversation.title;
  const state = watcherRowState(link);
  const dock = useWatcherDock(link?.watchedConversationId ?? null);
  const unseen = link ? watcherUnseenText(link, dock) : null;
  return (
    <div
      className={clsx("activity-thread is-watcher", active && "is-active", menu.open && "has-open-menu")}
      role="listitem"
      aria-posinset={position}
      aria-setsize={setSize}
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
