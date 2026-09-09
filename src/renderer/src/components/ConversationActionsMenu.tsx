import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  CheckCircle2,
  Columns2,
  History,
  Pencil,
  PictureInPicture2,
  Trash2,
  X,
  Clock,
  Copy,
  FolderOpen,
  Hash,
  Mail,
  Pin,
  RefreshCw,
  Settings,
} from "lucide-react";
import type { Conversation, WorkspaceRun } from "@shared/contracts";
import { workspaceRunAttentionView } from "../../../shared/attention";
import type { SidebarThreadView } from "../utils/sidebarModel";
import { navigateMenuItems } from "../utils/menuKeyboard";
import { canOrganizeThread, threadSnoozePresets } from "../../../shared/thread-organization";
import { ThreadSubmenu } from "./sidebar/ThreadSubmenu";
import "./sidebar/thread-actions.css";

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
  anchor?: { x: number; y: number };
  initialSubmenu?: "snooze";
  projectPath?: string;
  onMarkUnread?: () => void;
  onRegenerateTitle?: () => void;
  onProjectSettings?: () => void;
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
  anchor,
  initialSubmenu,
  projectPath,
  onMarkUnread,
  onRegenerateTitle,
  onProjectSettings,
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
  const [copyError, setCopyError] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<"snooze" | "copy" | null>(initialSubmenu ?? null);
  const [presets] = useState(() => threadSnoozePresets(new Date()));
  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    onSetPopover(node);
  }, [onSetPopover]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const position = (): void => {
      if (!menu) return;
      const trigger = document.querySelector<HTMLElement>(`[aria-controls="conversation-actions-${conversation.id}"]`);
      const bounds = trigger?.getBoundingClientRect();
      const x = anchor?.x ?? bounds?.right ?? 8;
      const y = anchor?.y ?? bounds?.bottom ?? 8;
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
      ?.focus({ preventScroll: true });
    return () => window.removeEventListener("resize", position);
  }, [anchor, conversation.id]);

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
  const copy = async (text: string): Promise<void> => {
    try {
      if (!await window.inertia.copyText(text)) throw new Error("Clipboard unavailable");
      onDismiss("selection");
    } catch { setCopyError("Could not copy. Please try again."); }
  };

  return createPortal(
    <div
      ref={setMenuRef}
      id={`conversation-actions-${conversation.id}`}
      className="conversation-menu thread-actions-popover"
      role="menu"
      aria-label={`Thread actions for ${conversation.title}`}
      data-work-focus-owner={activity
        ? `thread-actions:${conversation.id}`
        : undefined}
      onKeyDown={(event) => navigateMenuItems(event, ':scope > button:not(:disabled), :scope > .thread-submenu-owner > button:not(:disabled)')}
    >
      <ConversationMenuItem
        {...itemProps}
        onActivate={() => onPinConversation(conversation, !conversation.pinnedAt)}
      >
        <Pin size={13} />{conversation.pinnedAt ? "Unpin thread" : "Pin thread"}
      </ConversationMenuItem>
      <ConversationMenuItem
        {...itemProps}
        disabled={!canSettle}
        onActivate={() => conversation.settledAt ? onRestoreConversation(conversation) : onSettleConversation(conversation)}
      >
        <CheckCircle2 size={13} />{conversation.settledAt ? "Reopen thread" : "Settle thread"}
      </ConversationMenuItem>
      <ThreadSubmenu label="Snooze" icon={<Clock size={13} />} disabled={!canOrganizeThread(conversation, runs)}
        open={submenu === "snooze"} onOpenChange={(open) => setSubmenu((current) => open ? "snooze" : current === "snooze" ? null : current)}>
        {conversation.snoozedUntil && <ConversationMenuItem {...itemProps} onActivate={() => onSnoozeConversation(conversation, null)}><History size={13} />Unsnooze</ConversationMenuItem>}
        {presets.map((preset) => <ConversationMenuItem {...itemProps} key={preset.id} onActivate={() => {
          const current = threadSnoozePresets(new Date()).find(({ id }) => id === preset.id);
          if (current) onSnoozeConversation(conversation, current.until);
        }}>{preset.label}</ConversationMenuItem>)}
      </ThreadSubmenu>
      <div role="separator" />
      <ConversationMenuItem {...itemProps} restoreFocus={false} onActivate={onStartRename}><Pencil size={13} />Rename thread</ConversationMenuItem>
      {onRegenerateTitle && <ConversationMenuItem {...itemProps} disabled={!canSettle} title="Use the latest user message as the title. Runs locally without an AI request." onActivate={onRegenerateTitle}><RefreshCw size={13} />Regenerate title</ConversationMenuItem>}
      {onMarkUnread && <ConversationMenuItem {...itemProps} onActivate={onMarkUnread}><Mail size={13} />Mark unread</ConversationMenuItem>}
      <div role="separator" />
      <ThreadSubmenu label="Copy" icon={<Copy size={13} />} open={submenu === "copy"}
        onOpenChange={(open) => setSubmenu((current) => open ? "copy" : current === "copy" ? null : current)}>
        <button type="button" role="menuitem" tabIndex={-1} disabled={!conversation.worktreePath && !projectPath} onClick={() => void copy(conversation.worktreePath ?? projectPath ?? "")}><FolderOpen size={13} />Path</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => void copy(conversation.id)}><Hash size={13} />Thread ID</button>
      </ThreadSubmenu>
      {copyError && <p className="thread-menu-error" role="alert">{copyError}</p>}
      {onProjectSettings && <ConversationMenuItem {...itemProps} restoreFocus={false} onActivate={onProjectSettings}><Settings size={13} />Project settings</ConversationMenuItem>}
      <div role="separator" />
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
      <div role="separator" />
      <ConversationMenuItem
        {...itemProps}
        disabled={!canSettle || isDetached}
        title={isDetached
          ? "Return this chat to the main window before archiving it."
          : undefined}
        onActivate={() => onArchiveConversation(conversation)}
      >
        <Archive size={13} />Archive thread
      </ConversationMenuItem>
      <ConversationMenuItem
        {...itemProps}
        className="is-danger"
        disabled={!canSettle || isDetached}
        title={isDetached
          ? "Return this chat to the main window before deleting it."
          : undefined}
        onActivate={() => onDeleteConversation(conversation)}
      >
        <Trash2 size={13} />Delete
      </ConversationMenuItem>
    </div>, document.body,
  );
}
