import clsx from "clsx";

import type { Conversation } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { watcherPresetName } from "../../utils/watcherLinks";
import { ProviderBrandIcon } from "../ProviderBrandIcon";

function watcherRowState(link: WatcherLinkView | undefined): string | null {
  if (!link) return null;
  if (link.status === "waking") return "Checking";
  if (link.status === "paused") return "Paused";
  return null;
}

/**
 * A watcher listed directly under the chat it watches. It shares the parent's
 * section and collapse state and joins the Work tab's arrow-key order.
 */
export function WatcherWorkRow({
  conversation,
  parentTitle,
  link,
  active,
  statusLabel,
  onActivate,
}: {
  conversation: Conversation;
  parentTitle: string;
  link: WatcherLinkView | undefined;
  active: boolean;
  statusLabel: string;
  onActivate: (conversation: Conversation) => void;
}): React.JSX.Element {
  const name = link ? `Watcher · ${watcherPresetName(link.preset)}` : conversation.title;
  const state = watcherRowState(link);
  return (
    <div
      className={clsx("activity-thread is-watcher", active && "is-active")}
      role="listitem"
      data-sidebar-motion-id={`watcher:${conversation.id}`}
      data-watcher-status={link?.status}
    >
      <button
        type="button"
        className="activity-thread-select watcher-work-row"
        data-sidebar-nav
        data-work-focus-id={`watcher:${conversation.id}`}
        aria-current={active ? "page" : undefined}
        aria-label={[`${name}, watching ${parentTitle}`, state ?? statusLabel].join(", ")}
        onClick={() => onActivate(conversation)}
      >
        <span className="watcher-work-row-line">
          <span className="watcher-work-row-branch" aria-hidden="true" />
          <span className="activity-thread-provider" aria-hidden="true">
            <ProviderBrandIcon providerId={conversation.providerId} decorative size={12} />
          </span>
          <span className="watcher-work-row-title">{name}</span>
          {state && <span className="watcher-work-row-state">{state}</span>}
        </span>
      </button>
    </div>
  );
}
