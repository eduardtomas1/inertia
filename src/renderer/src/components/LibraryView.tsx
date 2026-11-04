import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, ExternalLink, LayoutTemplate, Pencil, Search, Trash2, X } from "lucide-react";
import clsx from "clsx";
import type { AppSnapshot, ServerEvent } from "@shared/contracts";
import { HTML_RENDER_DEFAULT_HEIGHT } from "@shared/html-render";
import type { LibraryCategory, LibraryPage } from "@shared/library";
import type { MessageSearchTarget } from "@shared/message-search";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import { LibraryAnswerCard } from "./library/LibraryAnswerCard";
import { LibraryCategoryRail } from "./library/LibraryCategoryRail";
import { LibraryMenu, type LibraryMenuAnchor, type LibraryMenuEntry } from "./library/LibraryMenu";
import { LibraryPageCard, usePagePreviewSlots } from "./library/LibraryPages";
import { libraryCategoryEntries } from "./library/LibrarySaveMenu";
import { libraryError, rememberLibraryCategory } from "./library/librarySavePreference";
import {
  countLabel,
  inLibraryFilter,
  libraryCounts,
  libraryFilterName,
  libraryPageMatches,
  savedAnswerEntries,
  savedAnswerMatches,
  savedAnswerTarget,
  type LibraryFilter,
  type SavedAnswerEntry,
} from "./library/libraryModel";
import { IconButton, LoadingMark } from "./ui";
import "./LibraryView.css";

const HtmlRenderDialog = lazy(async () => ({
  default: (await import("./response-timeline/html-render-dialog")).HtmlRenderDialog,
}));

export type LibraryTab = "answers" | "pages";

export interface LibraryTurnTarget {
  conversationId: string;
  turnId: string;
}

export interface LibraryViewProps {
  snapshot: AppSnapshot | null;
  status: ConnectionStatus;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onOpenAnswer: (target: MessageSearchTarget) => void;
  onOpenTurn: (target: LibraryTurnTarget) => void;
  onError: (message: string) => void;
}

type LibraryMenuState =
  | { kind: "category"; categoryId: string; anchor: LibraryMenuAnchor; trigger: HTMLElement | null; confirm: boolean }
  | { kind: "move"; savedAnswerId: string; anchor: LibraryMenuAnchor; trigger: HTMLElement | null };

interface PendingOpen {
  conversationId: string;
  open: () => void;
}

const TABS: readonly { id: LibraryTab; label: string }[] = [
  { id: "answers", label: "Saved answers" },
  { id: "pages", label: "Pages" },
];

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }): React.JSX.Element {
  return (
    <div className="library-empty">
      <span className="library-empty-mark" aria-hidden="true">{icon}</span>
      <p className="library-empty-title">{title}</p>
      <p className="library-empty-detail">{detail}</p>
    </div>
  );
}

export function LibraryView({
  snapshot,
  status,
  request,
  onOpenAnswer,
  onOpenTurn,
  onError,
}: LibraryViewProps): React.JSX.Element {
  const [tab, setTab] = useState<LibraryTab>("answers");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>({ kind: "all" });
  const [menu, setMenu] = useState<LibraryMenuState | null>(null);
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renamingAnswerId, setRenamingAnswerId] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [pages, setPages] = useState<LibraryPage[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [openPage, setOpenPage] = useState<LibraryPage | null>(null);
  const pendingOpen = useRef<PendingOpen | null>(null);
  const [restoreTick, setRestoreTick] = useState(0);
  const tabRefs = useRef(new Map<LibraryTab, HTMLButtonElement>());
  const pagesRequest = useRef(0);
  useMinuteClock(true);
  const offline = status !== "online";
  const library = snapshot?.library;
  const categories = useMemo(() => library?.categories ?? [], [library?.categories]);
  const conversations = snapshot?.conversations;
  const entries = useMemo(
    () => savedAnswerEntries(library, conversations ?? [], snapshot?.projects ?? []),
    [conversations, library, snapshot?.projects],
  );
  const counts = useMemo(() => libraryCounts(entries), [entries]);
  const effectiveFilter = useMemo<LibraryFilter>(() => {
    if (filter.kind === "category" && !categories.some(({ id }) => id === filter.id)) return { kind: "all" };
    return filter.kind === "unsorted" && counts.unsorted === 0 ? { kind: "all" } : filter;
  }, [categories, counts.unsorted, filter]);
  const visibleEntries = useMemo(
    () => entries.filter((entry) => inLibraryFilter(entry, effectiveFilter) && savedAnswerMatches(entry, query)),
    [effectiveFilter, entries, query],
  );
  const knownConversationIds = useMemo(() => new Set((conversations ?? []).map(({ id }) => id)), [conversations]);
  const archivedConversationIds = useMemo(
    () => new Set((conversations ?? []).filter(({ archivedAt }) => archivedAt !== null).map(({ id }) => id)),
    [conversations],
  );
  const visiblePages = useMemo(
    () => (pages ?? [])
      .filter((page) => knownConversationIds.has(page.conversationId) && libraryPageMatches(page, query))
      .map((page) => page.archived === archivedConversationIds.has(page.conversationId)
        ? page
        : { ...page, archived: !page.archived }),
    [archivedConversationIds, knownConversationIds, pages, query],
  );

  const visiblePageIds = useMemo(() => visiblePages.map(({ renderId }) => renderId), [visiblePages]);
  const previews = usePagePreviewSlots(visiblePageIds);

  const loadPages = useCallback((): void => {
    const sequence = ++pagesRequest.current;
    void request({ type: "library.pages.list", payload: {} }).then((event) => {
      if (sequence !== pagesRequest.current) return;
      const result = resultEvent(event).result;
      if (result.kind !== "library.pages") throw new Error("The Library returned an unexpected response.");
      setPages(result.pages);
      setPagesError(null);
    }).catch((error: unknown) => {
      if (sequence !== pagesRequest.current) return;
      setPagesError(libraryError(error, "Pages could not be loaded."));
    });
  }, [request]);

  useEffect(() => {
    if (tab !== "pages" || offline) return;
    loadPages();
    const refresh = (): void => loadPages();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadPages, offline, tab]);

  useEffect(() => {
    const pending = pendingOpen.current;
    if (!pending) return;
    const conversation = conversations?.find(({ id }) => id === pending.conversationId);
    if (!conversation) {
      pendingOpen.current = null;
      setOpening(null);
      return;
    }
    if (conversation.archivedAt !== null) return;
    pendingOpen.current = null;
    setOpening(null);
    pending.open();
  }, [conversations, restoreTick]);

  const run = useCallback(async (command: CommandWithoutId, fallback: string): Promise<ServerEvent | null> => {
    try {
      return await request(command);
    } catch (error) {
      onError(libraryError(error, fallback));
      return null;
    }
  }, [onError, request]);

  const openAfterRestore = useCallback((conversationId: string, key: string, open: () => void): void => {
    if (!archivedConversationIds.has(conversationId)) {
      open();
      return;
    }
    setOpening(key);
    void run({ type: "conversation.unarchive", payload: { conversationId } }, "This chat could not be restored.")
      .then((event) => {
        if (!event) {
          setOpening(null);
          return;
        }
        pendingOpen.current = { conversationId, open };
        setRestoreTick((tick) => tick + 1);
      });
  }, [archivedConversationIds, run]);

  const openEntry = useCallback((entry: SavedAnswerEntry): void => {
    const target = savedAnswerTarget(entry);
    openAfterRestore(entry.conversation.id, entry.answer.id, () => onOpenAnswer({
      ...target,
      projectId: snapshot?.conversations.find(({ id }) => id === target.conversationId)?.projectId ?? target.projectId,
    }));
  }, [onOpenAnswer, openAfterRestore, snapshot?.conversations]);

  const goToPage = useCallback((page: LibraryPage): void => {
    setOpenPage(null);
    openAfterRestore(page.conversationId, page.renderId, () => {
      const projectId = snapshot?.conversations.find(({ id }) => id === page.conversationId)?.projectId ?? page.projectId;
      if (page.messageId) {
        onOpenAnswer({ projectId, conversationId: page.conversationId, turnId: page.turnId, messageId: page.messageId });
      } else {
        onOpenTurn({ conversationId: page.conversationId, turnId: page.turnId });
      }
    });
  }, [onOpenAnswer, onOpenTurn, openAfterRestore, snapshot?.conversations]);

  const createCategory = useCallback(async (name: string): Promise<string | null> => {
    try {
      const result = resultEvent(await request({ type: "library.category.create", payload: { name } })).result;
      if (result.kind === "library.category") setFilter({ kind: "category", id: result.category.id });
      return null;
    } catch (error) {
      return libraryError(error, "This category could not be created.");
    }
  }, [request]);

  const renameCategory = useCallback(async (category: LibraryCategory, name: string): Promise<string | null> => {
    try {
      await request({ type: "library.category.rename", payload: { categoryId: category.id, name } });
      return null;
    } catch (error) {
      return libraryError(error, "This category could not be renamed.");
    }
  }, [request]);

  const deleteCategory = useCallback((category: LibraryCategory): void => {
    if (effectiveFilter.kind === "category" && effectiveFilter.id === category.id) setFilter({ kind: "all" });
    window.requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document.querySelector<HTMLElement>('.library-rail [data-library-category="all"]')?.focus({ preventScroll: true });
    });
    void run({ type: "library.category.delete", payload: { categoryId: category.id } }, "This category could not be deleted.");
  }, [effectiveFilter, run]);

  const renameAnswer = useCallback(async (entry: SavedAnswerEntry, title: string | null): Promise<string | null> => {
    const finish = (): void => {
      setRenamingAnswerId(null);
      window.requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.querySelector<HTMLElement>(`[data-saved-answer-id="${entry.answer.id}"] [data-library-card-open]`)
          ?.focus({ preventScroll: true });
      });
    };
    if (title === null) {
      finish();
      return null;
    }
    try {
      await request({ type: "library.answer.update", payload: { savedAnswerId: entry.answer.id, title } });
      finish();
      return null;
    } catch (error) {
      return libraryError(error, "This title could not be saved.");
    }
  }, [request]);

  const moveAnswer = useCallback((savedAnswerId: string, categoryId: string | null): void => {
    rememberLibraryCategory(categoryId);
    void run({ type: "library.answer.update", payload: { savedAnswerId, categoryId } }, "This answer could not be moved.");
  }, [run]);

  const removeAnswer = useCallback((entry: SavedAnswerEntry): void => {
    const list = document.querySelector<HTMLElement>(".library-answer-list");
    const cards = [...(list?.querySelectorAll<HTMLElement>("[data-saved-answer-id]") ?? [])];
    const index = cards.findIndex((card) => card.dataset.savedAnswerId === entry.answer.id);
    const neighbour = cards[index + 1] ?? cards[index - 1];
    neighbour?.querySelector<HTMLElement>("[data-library-card-open]")?.focus({ preventScroll: true });
    void run({ type: "library.answer.remove", payload: { savedAnswerId: entry.answer.id } }, "This answer could not be removed.");
  }, [run]);

  const cardHandlers = useRef({ openEntry, renameAnswer, removeAnswer });
  cardHandlers.current = { openEntry, renameAnswer, removeAnswer };
  const stableCardHandlers = useMemo(() => ({
    onOpen: (entry: SavedAnswerEntry) => cardHandlers.current.openEntry(entry),
    onStartRename: (entry: SavedAnswerEntry) => setRenamingAnswerId(entry.answer.id),
    onRename: (entry: SavedAnswerEntry, title: string | null) => cardHandlers.current.renameAnswer(entry, title),
    onOpenMoveMenu: (entry: SavedAnswerEntry, anchor: LibraryMenuAnchor, trigger: HTMLElement) => {
      setMenu((current) => current?.kind === "move" && current.savedAnswerId === entry.answer.id
        ? null
        : { kind: "move", savedAnswerId: entry.answer.id, anchor, trigger });
    },
    onRemove: (entry: SavedAnswerEntry) => cardHandlers.current.removeAnswer(entry),
  }), []);
  const openPageDialog = useCallback((page: LibraryPage) => setOpenPage(page), []);

  if (!snapshot) {
    return (
      <main className="library-view" aria-labelledby="library-view-heading" aria-busy="true">
        <h1 className="visually-hidden" id="library-view-heading">Library</h1>
        <LoadingMark label="Loading the Library" />
      </main>
    );
  }

  const confirmDestructive = snapshot.settings.confirmDestructiveActions;
  const menuCategory = menu?.kind === "category" ? categories.find(({ id }) => id === menu.categoryId) ?? null : null;
  const menuEntry = menu?.kind === "move" ? entries.find(({ answer }) => answer.id === menu.savedAnswerId) ?? null : null;
  const categoryMenuEntries = (category: LibraryCategory, confirm: boolean): LibraryMenuEntry[] => {
    const count = counts.byCategory.get(category.id) ?? 0;
    if (confirm) {
      return [
        {
          kind: "heading",
          id: "confirm",
          label: `Delete “${category.name}”?`,
          detail: count > 0 ? `Its ${countLabel(count, "answer")} move to Unsorted.` : "It has no answers.",
        },
        {
          kind: "item",
          id: "delete",
          label: "Delete category",
          icon: <Trash2 size={14} aria-hidden="true" />,
          danger: true,
          restoreFocus: false,
          onSelect: () => deleteCategory(category),
        },
        { kind: "item", id: "cancel", label: "Cancel", onSelect: () => undefined },
      ];
    }
    return [
      {
        kind: "item",
        id: "rename",
        label: "Rename",
        icon: <Pencil size={14} aria-hidden="true" />,
        disabled: offline,
        restoreFocus: false,
        onSelect: () => setRenamingCategoryId(category.id),
      },
      confirmDestructive ? {
        kind: "item",
        id: "delete",
        label: "Delete…",
        icon: <Trash2 size={14} aria-hidden="true" />,
        danger: true,
        disabled: offline,
        keepOpen: true,
        onSelect: () => setMenu((current) => current?.kind === "category" ? { ...current, confirm: true } : current),
      } : {
        kind: "item",
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={14} aria-hidden="true" />,
        danger: true,
        disabled: offline,
        restoreFocus: false,
        onSelect: () => deleteCategory(category),
      },
    ];
  };
  const moveMenuEntries = (entry: SavedAnswerEntry): LibraryMenuEntry[] => [
    { kind: "heading", id: "heading", label: "Move to" },
    ...libraryCategoryEntries({
      categories,
      currentCategoryId: entry.answer.categoryId,
      onMove: (categoryId) => moveAnswer(entry.answer.id, categoryId),
      onCreate: async (name) => {
        try {
          const result = resultEvent(await request({ type: "library.category.create", payload: { name } })).result;
          if (result.kind === "library.category") moveAnswer(entry.answer.id, result.category.id);
          return null;
        } catch (error) {
          return libraryError(error, "This category could not be created.");
        }
      },
    }),
  ];

  const summary = tab === "answers"
    ? entries.length === 0 ? "Nothing saved yet" : `${countLabel(entries.length, "saved answer")} · ${countLabel(categories.length, "category", "categories")}`
    : pages === null ? "Gathering pages" : countLabel(visiblePagesCount(pages, knownConversationIds), "page");
  const filterName = libraryFilterName(effectiveFilter, categories);
  const searching = query.trim().length > 0;

  return (
    <main className="library-view" aria-labelledby="library-view-heading">
      <div className="library-layout">
        <header className="library-header">
          <div className="library-heading">
            <h1 id="library-view-heading">Library</h1>
            <p>{summary}</p>
          </div>
          <div className="library-toolbar">
            <div className="library-tabs" role="tablist" aria-label="Library sections">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  ref={(node) => {
                    if (node) tabRefs.current.set(id, node);
                    else tabRefs.current.delete(id);
                  }}
                  type="button"
                  role="tab"
                  id={`library-tab-${id}`}
                  aria-controls={`library-panel-${id}`}
                  aria-selected={tab === id}
                  tabIndex={tab === id ? 0 : -1}
                  className={clsx(tab === id && "is-active")}
                  onClick={() => setTab(id)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const next = TABS[(TABS.findIndex((candidate) => candidate.id === id) + 1) % TABS.length]!.id;
                    setTab(next);
                    tabRefs.current.get(next)?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="library-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder="Search"
                aria-label="Search the Library"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query && (
                <IconButton label="Clear search" className="library-search-clear" onClick={() => setQuery("")}>
                  <X size={14} aria-hidden="true" />
                </IconButton>
              )}
            </div>
          </div>
        </header>

        {tab === "answers" ? (
          <section
            className="library-answers"
            role="tabpanel"
            id="library-panel-answers"
            aria-labelledby="library-tab-answers"
          >
            <LibraryCategoryRail
              categories={categories}
              counts={counts}
              filter={effectiveFilter}
              disabled={offline}
              renamingId={renamingCategoryId}
              menuCategoryId={menuCategory?.id ?? null}
              onFilter={setFilter}
              onCreate={createCategory}
              onRename={renameCategory}
              onStartRename={(category) => setRenamingCategoryId(category.id)}
              onRenameDone={() => setRenamingCategoryId(null)}
              onOpenMenu={(category, anchor, trigger) => setMenu((current) => (
                current?.kind === "category" && current.categoryId === category.id
                  ? null
                  : { kind: "category", categoryId: category.id, anchor, trigger, confirm: false }
              ))}
            />
            <div className="library-answer-column">
              <h2 className="visually-hidden">{filterName}</h2>
              {entries.length === 0 ? (
                <EmptyState
                  icon={<Bookmark size={16} />}
                  title="Nothing saved yet"
                  detail="Keep an answer worth returning to: choose the bookmark beside Copy under any reply. It waits for you here."
                />
              ) : visibleEntries.length === 0 ? (
                <EmptyState
                  icon={searching ? <Search size={16} /> : <Bookmark size={16} />}
                  title={searching ? `Nothing matches “${query.trim()}”` : `${filterName} is empty`}
                  detail={searching
                    ? "Try another word from a title, the answer or its chat."
                    : "Move answers here from their card, or pick this category as you save."}
                />
              ) : (
                <ul className="library-answer-list" aria-label={`${filterName} answers`}>
                  {visibleEntries.map((entry) => (
                    <LibraryAnswerCard
                      key={entry.answer.id}
                      entry={entry}
                      disabled={offline}
                      renaming={renamingAnswerId === entry.answer.id}
                      menuOpen={menu?.kind === "move" && menu.savedAnswerId === entry.answer.id}
                      opening={opening === entry.answer.id}
                      {...stableCardHandlers}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : (
          <section
            className="library-pages"
            role="tabpanel"
            id="library-panel-pages"
            aria-labelledby="library-tab-pages"
            aria-busy={pages === null && !pagesError ? true : undefined}
          >
            {pagesError && pages === null ? (
              <EmptyState icon={<LayoutTemplate size={16} />} title="Pages could not be loaded" detail={pagesError} />
            ) : pages === null ? (
              <LoadingMark label="Loading pages" />
            ) : visiblePages.length === 0 ? (
              <EmptyState
                icon={searching ? <Search size={16} /> : <LayoutTemplate size={16} />}
                title={searching ? `Nothing matches “${query.trim()}”` : "No pages yet"}
                detail={searching
                  ? "Try a word from the page title or its chat."
                  : "When an agent draws you a page — a chart, a table, a mockup — it is kept here to open again."}
              />
            ) : (
              <ul className="library-page-grid" aria-label="Pages">
                {visiblePages.map((page) => (
                  <LibraryPageCard
                    key={page.renderId}
                    page={page}
                    previewMounted={previews.mounted.has(page.renderId)}
                    observe={previews.observe}
                    onPreviewFailed={previews.markFailed}
                    onOpen={openPageDialog}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {menu?.kind === "category" && menuCategory && (
        <LibraryMenu
          key={`${menuCategory.id}:${menu.confirm ? "confirm" : "actions"}`}
          label={menu.confirm ? `Delete ${menuCategory.name}` : `Actions for ${menuCategory.name}`}
          anchor={menu.anchor}
          trigger={menu.trigger}
          entries={categoryMenuEntries(menuCategory, menu.confirm)}
          onDismiss={() => setMenu(null)}
        />
      )}
      {menu?.kind === "move" && menuEntry && (
        <LibraryMenu
          label="Move to category"
          anchor={menu.anchor}
          trigger={menu.trigger}
          align="end"
          entries={moveMenuEntries(menuEntry)}
          onDismiss={() => setMenu(null)}
        />
      )}
      {openPage && (
        <Suspense fallback={null}>
          <HtmlRenderDialog
            reference={{ renderId: openPage.renderId, title: openPage.title, height: openPage.height ?? HTML_RENDER_DEFAULT_HEIGHT }}
            onClose={() => setOpenPage(null)}
            headerActions={(
              <button type="button" className="library-dialog-action" onClick={() => goToPage(openPage)}>
                <ExternalLink size={14} aria-hidden="true" />
                <span>{archivedConversationIds.has(openPage.conversationId) ? "Restore and go to answer" : "Go to answer"}</span>
              </button>
            )}
          />
        </Suspense>
      )}
    </main>
  );
}

function visiblePagesCount(pages: readonly LibraryPage[], conversations: ReadonlySet<string>): number {
  return pages.filter(({ conversationId }) => conversations.has(conversationId)).length;
}
