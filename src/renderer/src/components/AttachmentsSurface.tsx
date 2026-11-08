import { Eye, Paperclip } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  CONVERSATION_ATTACHMENT_GALLERY_FILTERS,
  filterConversationAttachmentGallery,
  type ConversationAttachmentGalleryFilter,
  type ConversationAttachmentGalleryItem,
} from "@shared/conversation-attachment-gallery";
import { ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT, type EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { navigateMenuItems } from "../utils/menuKeyboard";
import type { AttachmentPreviewSource } from "../utils/composerAttachments";
import { requestComposerReattach } from "./composer/composerAttachmentReattach";
import { SentMessageAttachmentList, type SentAttachmentItemActions } from "./SentMessageAttachmentList";
import "./WorkspaceSurfaces.css";
import "./AttachmentsSurface.css";

export interface AttachmentsSurfaceProps {
  attachments: EnvironmentSummarySnapshot["attachments"];
  /** The chat whose draft receives re-attached files; null disables re-attach. */
  conversationId?: string | null;
}

const FILTER_LABELS: Readonly<Record<ConversationAttachmentGalleryFilter, string>> = {
  all: "All",
  images: "Images",
  documents: "Documents",
  text: "Text",
};
const EMPTY_FILTER_LABELS: Readonly<Record<Exclude<ConversationAttachmentGalleryFilter, "all">, string>> = {
  images: "No images",
  documents: "No documents",
  text: "No text files",
};
const MENU_MARGIN = 8;
const TABBABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]",
].join(", ");

/**
 * The menu is portaled to the end of the page, so a Tab inside it would leave
 * for the page's end. Tab moves on to the control after the item that opened
 * the menu; Shift+Tab returns to that item.
 */
function nextTabbableAfter(origin: HTMLElement, menu: HTMLElement | null): HTMLElement {
  const next = [...document.querySelectorAll<HTMLElement>(TABBABLE)].find((element) =>
    element !== origin
    && element.tabIndex >= 0
    && !menu?.contains(element)
    && !element.closest("[inert], [hidden], [aria-hidden='true']")
    && (origin.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  return next ?? origin;
}

interface ReattachStatus {
  readonly conversationId: string;
  readonly tone: "progress" | "success" | "error";
  readonly message: string;
}

interface ItemMenu {
  readonly item: ConversationAttachmentGalleryItem;
  readonly anchor: { x: number; y: number };
  readonly previewButton: HTMLButtonElement;
}

function galleryItem(attachment: AttachmentPreviewSource): ConversationAttachmentGalleryItem {
  return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
}

function AttachmentItemMenu({
  menu,
  reattachUnavailable,
  onReattach,
  onClose,
}: {
  menu: ItemMenu;
  reattachUnavailable: boolean;
  onReattach: (item: ConversationAttachmentGalleryItem) => void;
  onClose: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (restoreFocus: boolean): void => {
    if (restoreFocus && menu.previewButton.isConnected) menu.previewButton.focus({ preventScroll: true });
    onClose();
  };
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.max(MENU_MARGIN, Math.min(menu.anchor.x, window.innerWidth - rect.width - MENU_MARGIN));
    const top = Math.max(MENU_MARGIN, Math.min(menu.anchor.y, window.innerHeight - rect.height - MENU_MARGIN));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const dismiss = (): void => onClose();
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [onClose]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const origin = menu.previewButton;
      const target = !origin.isConnected
        ? null
        : event.shiftKey ? origin : nextTabbableAfter(origin, menuRef.current);
      close(false);
      target?.focus({ preventScroll: true });
      return;
    }
    navigateMenuItems(event, "button[role='menuitem']:not(:disabled)");
  };
  return createPortal(
    <div
      ref={menuRef}
      className="conversation-menu attachments-surface-menu"
      role="menu"
      aria-label={`Actions for ${menu.item.name}`}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        disabled={reattachUnavailable}
        onClick={() => {
          close(true);
          onReattach(menu.item);
        }}
      >
        <Paperclip size={14} aria-hidden="true" />
        <span>Re-attach to message</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          close(false);
          menu.previewButton.click();
        }}
      >
        <Eye size={14} aria-hidden="true" />
        <span>Preview</span>
      </button>
    </div>,
    document.body,
  );
}

export function AttachmentsSurface({ attachments, conversationId = null }: AttachmentsSurfaceProps): React.JSX.Element {
  const headingId = useId();
  const [filter, setFilter] = useState<ConversationAttachmentGalleryFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [status, setStatus] = useState<ReattachStatus | null>(null);
  const [menu, setMenu] = useState<ItemMenu | null>(null);
  const mountedRef = useRef(true);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const visible = useMemo(
    () => filterConversationAttachmentGallery(attachments, filter),
    [attachments, filter],
  );

  const reattach = useCallback(async (item: ConversationAttachmentGalleryItem): Promise<void> => {
    if (!conversationId || pendingRef.current) return;
    pendingRef.current = true;
    setPendingId(item.id);
    setStatus({ conversationId, tone: "progress", message: `Adding ${item.name} to the message…` });
    try {
      const outcome = await requestComposerReattach(conversationId, item);
      if (!mountedRef.current || conversationRef.current !== conversationId) return;
      setStatus(outcome.status === "attached"
        ? { conversationId, tone: "success", message: `Added ${item.name} to the message.` }
        : { conversationId, tone: "error", message: outcome.message });
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPendingId(null);
    }
  }, [conversationId]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const actions = useMemo<SentAttachmentItemActions>(() => ({
    render: (attachment) => (
      <button
        type="button"
        className="attachments-surface-reattach"
        aria-label={`Re-attach ${attachment.name} to the message`}
        title="Add this file to the message again"
        disabled={!conversationId}
        aria-disabled={pendingId !== null || undefined}
        aria-busy={pendingId === attachment.id || undefined}
        onClick={() => void reattach(galleryItem(attachment))}
      >
        <Paperclip size={14} aria-hidden="true" />
        <span>Re-attach</span>
      </button>
    ),
    onContextMenu: (attachment, anchor, previewButton) => {
      setMenu({ item: galleryItem(attachment), anchor, previewButton });
    },
  }), [conversationId, pendingId, reattach]);

  const activeMenu = menu && visible.some(({ id }) => id === menu.item.id) ? menu : null;
  const shownStatus = status && status.conversationId === conversationId ? status : null;
  const heading = attachments.length === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT
    ? `Newest ${ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT} attachments`
    : `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;

  return (
    <section className="workspace-surface attachments-surface" aria-label="Attachments">
      <div className="workspace-surface-scroll">
        {attachments.length === 0 ? (
          <p className="workspace-surface-empty">No attachments</p>
        ) : (
          <section className="workspace-surface-section attachments-surface-gallery environment-attachments"
            data-expanded="true" aria-labelledby={headingId}>
            <div className="environment-attachments-header">
              <h3 id={headingId}>{heading}</h3>
              <div className="attachments-surface-filters" role="group" aria-label="Show attachments">
                {CONVERSATION_ATTACHMENT_GALLERY_FILTERS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="attachments-surface-filter"
                    aria-pressed={filter === option}
                    onClick={() => setFilter(option)}
                  >
                    {FILTER_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>
            <p
              className="attachments-surface-status"
              role="status"
              data-tone={shownStatus?.tone}
            >
              {shownStatus?.message ?? ""}
            </p>
            <div className="environment-attachments-gallery">
              {visible.length === 0 && filter !== "all" ? (
                <p className="workspace-surface-empty">{EMPTY_FILTER_LABELS[filter]}</p>
              ) : (
                <SentMessageAttachmentList attachments={visible} label="Chat attachments" actions={actions} />
              )}
            </div>
          </section>
        )}
      </div>
      {activeMenu && (
        <AttachmentItemMenu
          menu={activeMenu}
          reattachUnavailable={!conversationId || pendingId !== null}
          onReattach={(item) => void reattach(item)}
          onClose={closeMenu}
        />
      )}
    </section>
  );
}
