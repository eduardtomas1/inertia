import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { Bookmark } from "lucide-react";
import clsx from "clsx";
import type { ChatMessage } from "@shared/contracts";
import type { SavedAnswer } from "@shared/library";

import { resultEvent } from "../../lib/runtimeCommands";
import { TooltipButton } from "../TooltipButton";
import { useLibraryAnswers, type LibraryAnswerController } from "./LibraryAnswerContext";
import type { LibraryMenuAnchor } from "./LibraryMenu";
import { libraryError, readLastLibraryCategory, rememberLibraryCategory } from "./librarySavePreference";
import "./LibrarySave.css";

const loadSaveMenu = () => import("./LibrarySaveMenu");
const LibrarySaveMenu = lazy(async () => ({ default: (await loadSaveMenu()).LibrarySaveMenu }));

interface LibrarySaveButtonProps {
  answer: Pick<ChatMessage, "id" | "conversationId">;
  turnId: string;
}

export function LibrarySaveButton(props: LibrarySaveButtonProps): React.JSX.Element | null {
  const controller = useLibraryAnswers();
  if (!controller?.library) return null;
  return <LibrarySaveControl {...props} controller={controller} />;
}

function LibrarySaveControl({
  answer,
  turnId,
  controller,
}: LibrarySaveButtonProps & { controller: LibraryAnswerController }): React.JSX.Element {
  const { request, onError, online } = controller;
  const library = controller.library!;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<LibraryMenuAnchor | null>(null);
  const [pending, setPending] = useState<{ categoryId: string | null } | null>(null);
  const [settling, setSettling] = useState(false);
  const savePromise = useRef<Promise<SavedAnswer | null> | null>(null);
  const [created, setCreated] = useState<SavedAnswer | null>(null);
  const stored = controller.savedByMessageId.get(answer.id) ?? null;
  if (stored && created) setCreated(null);
  const saved = stored ?? created;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const isSaved = saved !== null || pending !== null;
  const label = isSaved ? "Saved to Library" : "Save to Library";
  const currentCategoryId = saved ? saved.categoryId : pending?.categoryId ?? null;

  const save = useCallback((categoryId: string | null): Promise<SavedAnswer | null> => {
    setPending({ categoryId });
    const promise = request({
      type: "library.answer.save",
      payload: { conversationId: answer.conversationId, turnId, messageId: answer.id, categoryId },
    }).then((event) => {
      const result = resultEvent(event).result;
      if (result.kind !== "library.answer") return null;
      setCreated(result.savedAnswer);
      return result.savedAnswer;
    }).catch((error: unknown) => {
      setMenu(null);
      onError(libraryError(error, "This answer could not be saved to the Library."));
      return null;
    }).finally(() => {
      setPending(null);
      if (savePromise.current === promise) savePromise.current = null;
    });
    savePromise.current = promise;
    return promise;
  }, [answer.conversationId, answer.id, onError, request, turnId]);

  const resolveSaved = useCallback(async (): Promise<SavedAnswer | null> => {
    if (savedRef.current) return savedRef.current;
    const created = await savePromise.current;
    return (savedRef.current as SavedAnswer | null) ?? created ?? null;
  }, []);

  const move = useCallback(async (categoryId: string | null): Promise<void> => {
    rememberLibraryCategory(categoryId);
    const current = await resolveSaved();
    if (!current || current.categoryId === categoryId) return;
    try {
      await request({ type: "library.answer.update", payload: { savedAnswerId: current.id, categoryId } });
    } catch (error) {
      onError(libraryError(error, "This answer could not be moved."));
    }
  }, [onError, request, resolveSaved]);

  const remove = useCallback(async (): Promise<void> => {
    const current = await resolveSaved();
    if (!current) return;
    setCreated(null);
    try {
      await request({ type: "library.answer.remove", payload: { savedAnswerId: current.id } });
    } catch (error) {
      onError(libraryError(error, "This answer could not be removed from the Library."));
    }
  }, [onError, request, resolveSaved]);

  const createCategory = useCallback(async (name: string): Promise<string | null> => {
    try {
      const result = resultEvent(await request({ type: "library.category.create", payload: { name } })).result;
      if (result.kind !== "library.category") return "The Library returned an unexpected response.";
      void move(result.category.id);
      return null;
    } catch (error) {
      return libraryError(error, "This category could not be created.");
    }
  }, [move, request]);

  return (
    <>
      <TooltipButton
        ref={buttonRef}
        className={clsx("turn-action library-save-toggle", isSaved && "is-saved", settling && "is-settling")}
        tooltip={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        disabled={!online}
        data-library-saved={isSaved || undefined}
        onPointerEnter={() => void loadSaveMenu()}
        onFocus={() => void loadSaveMenu()}
        onClick={(event) => {
          if (menu) {
            setMenu(null);
            return;
          }
          const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
          setMenu({ left, right, top, bottom });
          if (saved || pending) return;
          setSettling(true);
          void save(readLastLibraryCategory(library.categories));
        }}
      >
        <Bookmark
          size={14}
          aria-hidden="true"
          fill={isSaved ? "currentColor" : "none"}
          onAnimationEnd={() => setSettling(false)}
        />
      </TooltipButton>
      {menu && (
        <Suspense fallback={null}>
          <LibrarySaveMenu
            categories={library.categories}
            currentCategoryId={currentCategoryId}
            anchor={menu}
            trigger={buttonRef.current}
            onMove={(categoryId) => void move(categoryId)}
            onCreate={createCategory}
            onRemove={() => void remove()}
            onDismiss={() => setMenu(null)}
          />
        </Suspense>
      )}
    </>
  );
}
