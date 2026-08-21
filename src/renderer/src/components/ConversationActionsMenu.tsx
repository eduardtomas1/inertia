import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Columns2,
  History,
  MessageSquare,
  Pencil,
  PictureInPicture2,
  Trash2,
  X,
} from "lucide-react";
import type { Conversation, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import {
  nextSidebarNavigationIndex,
  type SidebarThreadView,
} from "../utils/sidebarModel";

type DismissReason = "selection" | "context-change";

interface ConversationMenuItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "role" | "tabIndex" | "type"
> {
  children: ReactNode;
  onActivate: () => void;
  onDismiss: (reason: DismissReason) => void;
  restoreFocus?: boolean;
}

function ConversationMenuItem({
  children,
  onActivate,
  onDismiss,
  restoreFocus = true,
  ...props
}: ConversationMenuItemProps): React.JSX.Element {
  return (
    <button
      {...props}
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        onDismiss(restoreFocus ? "selection" : "context-change");
        onActivate();
      }}
    >
      {children}
    </button>
  );
}

interface ConversationActionsMenuProps {
  activeConversationId: string | null;
  activity: boolean;
  conversation: Conversation;
  detachedChatLimitReached?: boolean;
  isDetached?: boolean;
  runs: readonly WorkspaceRun[];
  splitConversationId: string | null;
  thread: SidebarThreadView;
  onAcknowledgeRun: (run: WorkspaceRun) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onCloseConversationSplit: () => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onDismiss: (reason: DismissReason) => void;
  onDismissRun: (run: WorkspaceRun) => void;
  onOpenConversationInSplit: (conversation: Conversation) => void;
  onOpenConversationInWindow?: (conversation: Conversation) => void;
  onPinConversation: (conversation: Conversation, pinned: boolean) => void;
  onRestoreConversation: (conversation: Conversation) => void;
  onSetPopover: (node: HTMLDivElement | null) => void;
  onSettleConversation: (conversation: Conversation) => void;
  onSnoozeConversation: (conversation: Conversation, until: string | null) => void;
  onStartRename: () => void;
}

export function ConversationActionsMenu({
  activeConversationId,
  activity,
  conversation,
  detachedChatLimitReached = false,
  isDetached = false,
  runs,
  splitConversationId,
  thread,
  onAcknowledgeRun,
  onArchiveConversation,
  onCloseConversationSplit,
  onDeleteConversation,
  onDismiss,
  onDismissRun,
  onOpenConversationInSplit,
  onOpenConversationInWindow,
  onPinConversation,
  onRestoreConversation,
  onSetPopover,
  onSettleConversation,
  onSnoozeConversation,
  onStartRename,
}: ConversationActionsMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    onSetPopover(node);
  }, [onSetPopover]);

  useLayoutEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
      ?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const dismissAfterFocusLeaves = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) {
        onDismiss("context-change");
      }
    };
    document.addEventListener("focusin", dismissAfterFocusLeaves);
    return () => document.removeEventListener("focusin", dismissAfterFocusLeaves);
  }, [onDismiss]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    )];
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextSidebarNavigationIndex(
      currentIndex,
      event.key as "ArrowDown" | "ArrowUp" | "Home" | "End",
      items.length,
    );
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus({ preventScroll: true });
  };

  const activeRun = thread.run;
  const runAttention = activeRun ? workspaceRunAttentionView(activeRun) : null;
  const hasActiveWork = runs.some((run) => (
    run.conversationId === conversation.id
    && (run.status === "running" || run.status === "waiting")
  ));
  const canSettle = !hasActiveWork
    && conversation.status !== "running"
    && conversation.status !== "needs-input";
  const canOpenInSplit = Boolean(
    !isDetached
    && activeConversationId
    && activeConversationId !== conversation.id,
  );
  const itemProps = { onDismiss };

  return (
    <div
      ref={setMenuRef}
      id={`conversation-actions-${conversation.id}`}
      className="conversation-menu"
      role="menu"
      aria-label={`Thread actions for ${conversation.title}`}
      data-work-focus-owner={activity
        ? `thread-actions:${conversation.id}`
        : undefined}
      onKeyDown={handleKeyDown}
    >
      <ConversationMenuItem
        {...itemProps}
        restoreFocus={false}
        onActivate={onStartRename}
      >
        <Pencil size={13} />Rename
      </ConversationMenuItem>
      <ConversationMenuItem
        {...itemProps}
        onActivate={() => onPinConversation(conversation, !conversation.pinnedAt)}
      >
        <MessageSquare size={13} />{conversation.pinnedAt ? "Unpin" : "Pin"}
      </ConversationMenuItem>
      {onOpenConversationInWindow && (
        <ConversationMenuItem
          {...itemProps}
          disabled={!isDetached && detachedChatLimitReached}
          title={!isDetached && detachedChatLimitReached
            ? "Close a chat window before opening another."
            : undefined}
          onActivate={() => onOpenConversationInWindow(conversation)}
        >
          <PictureInPicture2 size={13} />
          {isDetached ? "Focus chat window" : "Open chat in new window"}
        </ConversationMenuItem>
      )}
      {conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > Date.now() ? (
        <ConversationMenuItem
          {...itemProps}
          onActivate={() => onSnoozeConversation(conversation, null)}
        >
          <History size={13} />Unsnooze
        </ConversationMenuItem>
      ) : (
        <>
          <ConversationMenuItem
            {...itemProps}
            onActivate={() => onSnoozeConversation(
              conversation,
              new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
            )}
          >
            <History size={13} />Snooze for 1 hour
          </ConversationMenuItem>
          <ConversationMenuItem
            {...itemProps}
            onActivate={() => onSnoozeConversation(
              conversation,
              new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
            )}
          >
            <History size={13} />Snooze for 1 day
          </ConversationMenuItem>
        </>
      )}
      {splitConversationId === conversation.id ? (
        <ConversationMenuItem
          {...itemProps}
          onActivate={onCloseConversationSplit}
        >
          <Columns2 size={13} />Remove from split view
        </ConversationMenuItem>
      ) : (
        <ConversationMenuItem
          {...itemProps}
          disabled={!canOpenInSplit}
          title={canOpenInSplit
            ? undefined
            : isDetached
              ? "This chat is already open in its own window."
              : "Choose another chat first."}
          onActivate={() => onOpenConversationInSplit(conversation)}
        >
          <Columns2 size={13} />Add this chat to split view
        </ConversationMenuItem>
      )}
      {activeRun && thread.needsAttention && runAttention?.canAcknowledge && (
        <ConversationMenuItem
          {...itemProps}
          onActivate={() => onAcknowledgeRun(activeRun)}
        >
          <CheckCircle2 size={13} />Acknowledge
        </ConversationMenuItem>
      )}
      {activity && activeRun && runAttention?.canDismiss && (
        <ConversationMenuItem
          {...itemProps}
          onActivate={() => onDismissRun(activeRun)}
        >
          <X size={13} />Dismiss from Work
        </ConversationMenuItem>
      )}
      {conversation.settledAt ? (
        <ConversationMenuItem
          {...itemProps}
          onActivate={() => onRestoreConversation(conversation)}
        >
          <ArchiveRestore size={13} />Reopen
        </ConversationMenuItem>
      ) : canSettle ? (
        <ConversationMenuItem
          {...itemProps}
          onActivate={() => onSettleConversation(conversation)}
        >
          <CheckCircle2 size={13} />Done
        </ConversationMenuItem>
      ) : null}
      <ConversationMenuItem
        {...itemProps}
        disabled={hasActiveWork || isDetached}
        title={isDetached
          ? "Return this chat to the main window before archiving it."
          : undefined}
        onActivate={() => onArchiveConversation(conversation)}
      >
        <Archive size={13} />Archive
      </ConversationMenuItem>
      <ConversationMenuItem
        {...itemProps}
        className="is-danger"
        disabled={hasActiveWork || isDetached}
        title={isDetached
          ? "Return this chat to the main window before deleting it."
          : undefined}
        onActivate={() => onDeleteConversation(conversation)}
      >
        <Trash2 size={13} />Delete
      </ConversationMenuItem>
    </div>
  );
}
