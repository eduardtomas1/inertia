import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Copy,
  Edit3,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import "./PromptPresetMenu.css";

import {
  MAX_PROMPT_PRESETS,
  MAX_PROMPT_PRESET_BODY_CHARS,
  MAX_PROMPT_PRESET_NAME_CHARS,
  promptPresetNameFromBody,
  promptPresetRouteMatches,
  type PromptPreset,
  type PromptPresetDraft,
  type PromptPresetRoute,
} from "@shared/prompt-presets";
import { routeSupportsNativeFastModeIdentity } from "@shared/model-routing";
import { reorderedPromptPresetIds } from "../../utils/promptPresets";
import { menuId } from "./config";
import type {
  PromptPresetCommand,
  PromptPresetCommandRunner,
} from "./types";
import type { ComposerMenuController } from "./useComposerMenus";

type EditorState = {
  kind: "create" | "edit";
  preset: PromptPreset | null;
  name: string;
  body: string;
  route: PromptPresetRoute | null;
  position: number;
};

function normalizedSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function routeIdentityLabel(
  route: PromptPresetRoute,
  currentRoute: PromptPresetRoute,
): string {
  return [
    `Harness ${route.harnessId}`,
    `backend ${route.backendProfileId}`,
    `model ${route.modelId}`,
    `reasoning ${route.reasoningEffort ?? "provider default"}`,
    ...(!routeSupportsNativeFastModeIdentity(route)
      || (route.fastMode === undefined && currentRoute.fastMode !== true)
      ? []
      : [`speed ${route.fastMode ? "Fast" : "Standard"}`]),
  ].join(" · ");
}

export function PromptPresetMenu({
  presets,
  currentMessage,
  currentRoute,
  menuController,
  onApply,
  onCommand,
}: {
  presets: readonly PromptPreset[];
  currentMessage: string;
  currentRoute: PromptPresetRoute;
  menuController: ComposerMenuController;
  onApply: (preset: PromptPreset) => Promise<boolean>;
  onCommand: PromptPresetCommandRunner;
}): React.JSX.Element {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
    handleComposerMenuTriggerKeyDown,
    handleMoreMenuNavigation,
  } = menuController;
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const operationGenerationRef = useRef(0);
  const pendingGenerationRef = useRef<number | null>(null);
  const editorFocusIdentity = editor
    ? `${editor.kind}:${editor.preset?.id ?? "new"}`
    : null;
  const displayedEditorRoute = editor?.route ?? currentRoute;
  const displayedEditorRouteLabel = routeIdentityLabel(
    displayedEditorRoute,
    currentRoute,
  );
  const editorRouteDiffers = editor?.route !== null
    && editor?.route !== undefined
    && !promptPresetRouteMatches(currentRoute, editor.route);

  useEffect(() => {
    if (menu === "presets") return;
    operationGenerationRef.current += 1;
    pendingGenerationRef.current = null;
    setQuery("");
    setEditor(null);
    setPending(false);
    setError(null);
    setConfirmingDelete(false);
  }, [menu]);

  useEffect(() => {
    if (editorFocusIdentity) nameRef.current?.focus();
  }, [editorFocusIdentity]);

  const visiblePresets = useMemo(() => {
    const needle = normalizedSearch(query);
    if (!needle) return presets;
    return presets.filter((preset) =>
      `${preset.name} ${preset.body}`.toLocaleLowerCase().includes(needle));
  }, [presets, query]);

  const beginCreate = (): void => {
    const body = currentMessage.trim() ? currentMessage : "";
    setEditor({
      kind: "create",
      preset: null,
      name: body ? promptPresetNameFromBody(body) : "",
      body,
      route: null,
      position: presets.length,
    });
    setError(null);
  };
  const beginEdit = (preset: PromptPreset): void => {
    setEditor({
      kind: "edit",
      preset,
      name: preset.name,
      body: preset.body,
      route: preset.route,
      position: preset.position,
    });
    setError(null);
    setConfirmingDelete(false);
  };
  const returnToList = (): void => {
    setEditor(null);
    setConfirmingDelete(false);
    window.requestAnimationFrame(() => {
      document.getElementById(menuId("presets"))
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    });
  };
  const dispatch = (command: PromptPresetCommand): Promise<unknown> =>
    onCommand(command.type, command);
  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    const generation = operationGenerationRef.current;
    if (pendingGenerationRef.current === generation) return false;
    pendingGenerationRef.current = generation;
    setPending(true);
    setError(null);
    try {
      await operation();
      return operationGenerationRef.current === generation;
    } catch (caught) {
      if (operationGenerationRef.current === generation) {
        setError(caught instanceof Error
          ? caught.message
          : "The prompt preset could not be changed.");
      }
      throw caught;
    } finally {
      if (pendingGenerationRef.current === generation) {
        pendingGenerationRef.current = null;
      }
      if (operationGenerationRef.current === generation) setPending(false);
    }
  };
  const save = async (): Promise<void> => {
    if (!editor) return;
    const draft = {
      name: editor.name,
      body: editor.body,
      route: editor.route,
    } satisfies PromptPresetDraft;
    try {
      const completed = await run(() => editor.kind === "create"
        ? dispatch({ type: "prompt-preset.create", payload: draft })
        : dispatch({
            type: "prompt-preset.update",
            payload: {
              presetId: editor.preset!.id,
              expectedRevision: editor.preset!.revision,
              ...draft,
            },
          }));
      if (completed) returnToList();
    } catch {
      // The inline status keeps the latest draft available for correction.
    }
  };
  const move = async (
    preset: PromptPreset,
    direction: "up" | "down",
  ): Promise<void> => {
    const ids = reorderedPromptPresetIds(presets, preset.id, direction);
    if (!ids) return;
    try {
      const completed = await run(() => dispatch({
        type: "prompt-preset.reorder",
        payload: {
          expectedPresetIds: presets.map(({ id }) => id),
          presetIds: ids,
        },
      }));
      if (completed) {
        setEditor((current) => current?.preset?.id === preset.id
          ? {
              ...current,
              position: ids.indexOf(preset.id),
            }
          : current);
      }
    } catch {
      // Keep the editor open so the authoritative snapshot can settle.
    }
  };

  return (
    <div className="popover-anchor prompt-presets-control">
      <button
        ref={(node) => setMenuTrigger("presets", node)}
        type="button"
        className="icon-button"
        aria-label={`Prompt presets${presets.length ? `, ${presets.length} saved` : ""}`}
        aria-haspopup="dialog"
        aria-controls={menuId("presets")}
        aria-expanded={menu === "presets"}
        title="Prompt presets"
        onClick={() => toggleMenu("presets")}
        onKeyDown={(event) =>
          handleComposerMenuTriggerKeyDown("presets", event)}
      >
        <BookOpenText size={15} />
      </button>
      {menu === "presets" && (
        <div
          ref={(node) => setMenuPopover("presets", node)}
          id={menuId("presets")}
          className="composer-popover prompt-presets-popover"
          role="dialog"
          aria-label="Prompt presets"
          onKeyDown={(event) => {
            if (
              event.target instanceof HTMLInputElement
              || event.target instanceof HTMLTextAreaElement
            ) return;
            handleMoreMenuNavigation(event);
          }}
        >
          <div className="prompt-presets-heading">
            <span>
              <strong>Prompt presets</strong>
              <small>Reusable text · {presets.length}/{MAX_PROMPT_PRESETS}</small>
            </span>
            {!editor && (
              <button
                type="button"
                className="prompt-presets-add"
                disabled={presets.length >= MAX_PROMPT_PRESETS}
                onClick={beginCreate}
              >
                <Plus size={13} />New
              </button>
            )}
          </div>
          {!editor && error && (
            <p className="prompt-preset-error" role="status">{error}</p>
          )}
          {editor ? (
            <form
              className="prompt-preset-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label>
                <span>Name</span>
                <input
                  ref={nameRef}
                  value={editor.name}
                  maxLength={MAX_PROMPT_PRESET_NAME_CHARS}
                  disabled={pending}
                  onChange={(event) => setEditor({
                    ...editor,
                    name: event.currentTarget.value,
                  })}
                />
              </label>
              <label>
                <span>Prompt text</span>
                <textarea
                  value={editor.body}
                  maxLength={MAX_PROMPT_PRESET_BODY_CHARS}
                  disabled={pending}
                  rows={7}
                  onChange={(event) => setEditor({
                    ...editor,
                    body: event.currentTarget.value,
                  })}
                />
              </label>
              <label className="prompt-preset-route-toggle">
                <input
                  type="checkbox"
                  checked={editor.route !== null}
                  disabled={pending}
                  onChange={(event) => setEditor({
                    ...editor,
                    route: event.currentTarget.checked ? currentRoute : null,
                  })}
                />
                <span>
                  <strong>{editor.route
                    ? "Bound to saved model route"
                    : "Limit to current model route"}</strong>
                  <small title={displayedEditorRouteLabel}>
                    {displayedEditorRouteLabel}
                  </small>
                  {editorRouteDiffers && (
                    <small className="prompt-preset-route-rebind-note">
                      Saved route differs from this chat. Turn this off, then
                      on again to bind to the current route.
                    </small>
                  )}
                </span>
              </label>
              <small className="prompt-preset-safety-note">
                Text and optional route only. Attachments and chat context stay out.
              </small>
              {error && <p className="prompt-preset-error" role="status">{error}</p>}
              {editor.kind === "edit" && editor.preset && (
                <div className="prompt-preset-editor-tools">
                  <button
                    type="button"
                    aria-label={`Move ${editor.preset.name} up`}
                    title="Move up"
                    disabled={pending || editor.position === 0}
                    onClick={() => void move(editor.preset!, "up")}
                  ><ArrowUp size={13} /></button>
                  <button
                    type="button"
                    aria-label={`Move ${editor.preset.name} down`}
                    title="Move down"
                    disabled={
                      pending || editor.position === presets.length - 1
                    }
                    onClick={() => void move(editor.preset!, "down")}
                  ><ArrowDown size={13} /></button>
                  <button
                    type="button"
                    disabled={pending || presets.length >= MAX_PROMPT_PRESETS}
                    onClick={() => {
                      void run(() => dispatch({
                        type: "prompt-preset.duplicate",
                        payload: {
                          presetId: editor.preset!.id,
                          expectedRevision: editor.preset!.revision,
                        },
                      }))
                        .then((completed) => {
                          if (completed) returnToList();
                        })
                        .catch(() => undefined);
                    }}
                  ><Copy size={13} />Duplicate</button>
                  <button
                    type="button"
                    className={confirmingDelete ? "is-confirming" : undefined}
                    disabled={pending}
                    onClick={() => {
                      if (!confirmingDelete) {
                        setConfirmingDelete(true);
                        return;
                      }
                      void run(() => dispatch({
                        type: "prompt-preset.delete",
                        payload: {
                          presetId: editor.preset!.id,
                          expectedRevision: editor.preset!.revision,
                        },
                      }))
                        .then((completed) => {
                          if (completed) returnToList();
                        })
                        .catch(() => undefined);
                    }}
                  ><Trash2 size={13} />{confirmingDelete ? "Confirm delete" : "Delete"}</button>
                </div>
              )}
              <div className="prompt-preset-editor-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={returnToList}
                >Cancel</button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    pending || !editor.name.trim() || !editor.body.trim()
                  }
                >{pending ? "Saving…" : "Save preset"}</button>
              </div>
            </form>
          ) : (
            <>
              {presets.length > 0 && (
                <label className="prompt-presets-search">
                  <Search size={13} />
                  <input
                    value={query}
                    placeholder="Find a preset…"
                    aria-label="Find a prompt preset"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </label>
              )}
              {presets.length === 0 ? (
                <div className="prompt-presets-empty">
                  <BookOpenText size={17} />
                  <strong>Keep the prompts you reuse</strong>
                  <span>Presets never send automatically.</span>
                  <button type="button" onClick={beginCreate}>
                    <Plus size={13} />Create a preset
                  </button>
                </div>
              ) : visiblePresets.length === 0 ? (
                <p className="popover-empty">No presets match “{query.trim()}”.</p>
              ) : (
                <div className="prompt-presets-list">
                  {visiblePresets.map((preset) => {
                    const routeBlocked = preset.route !== null
                      && !promptPresetRouteMatches(currentRoute, preset.route);
                    const blockedReason = routeBlocked
                      ? `Available on ${routeIdentityLabel(preset.route!, currentRoute)}`
                      : null;
                    return (
                      <div className="prompt-preset-row" key={preset.id}>
                        <button
                          type="button"
                          className="prompt-preset-use"
                          aria-disabled={routeBlocked}
                          title={blockedReason ?? `Insert ${preset.name}`}
                          onClick={() => {
                            if (routeBlocked) return;
                            void onApply(preset).then((applied) => {
                              if (applied) dismissMenu("selection");
                              else setError(
                                "This preset does not fit in the current prompt.",
                              );
                            }).catch(() => setError(
                              "This preset could not be inserted.",
                            ));
                          }}
                        >
                          <BookOpenText size={14} />
                          <span>
                            <strong>{preset.name}</strong>
                            <small>{blockedReason ?? preset.body}</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="prompt-preset-edit"
                          aria-label={`Edit prompt preset: ${preset.name}`}
                          title={`Edit ${preset.name}`}
                          onClick={() => beginEdit(preset)}
                        ><Edit3 size={13} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
