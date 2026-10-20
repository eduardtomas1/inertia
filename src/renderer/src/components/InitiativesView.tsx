import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, CircleCheck, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import clsx from "clsx";
import type {
  AppSettings,
  AppSnapshot,
  Conversation,
  Initiative,
  InitiativeNote,
  InitiativePreferencesPatch,
  InitiativeStatus,
  ServerEvent,
} from "@shared/contracts";
import {
  compareInitiatives,
  INITIATIVE_BRIEF_CONFLICT_MESSAGE,
  INITIATIVE_STATUS_LABELS,
  INITIATIVE_STATUSES,
  initiativeMembers,
  initiativePreferencesPatchSchema,
  isInitiativeName,
  MAX_INITIATIVE_NAME_CHARS,
  type InitiativeColor,
} from "@shared/initiatives";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { ELECTRON_IPC_ERROR_PREFIX } from "../hooks/useDesktopTools";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { requestNewInitiative } from "../utils/initiativeDialog";
import {
  sidebarThreadViewMap,
  sortSidebarThreadViews,
  type SidebarThreadView,
} from "../utils/sidebarModel";
import { InitiativeDot } from "./initiatives/InitiativeMark";
import {
  forgetInitiativeBriefDraft,
  InitiativeBrief,
  InitiativeNotes,
  type BriefSaveOutcome,
  type InitiativeNoteCommand,
} from "./initiatives/InitiativeMemory";
import { InitiativeTools, type InitiativeToolsSettings } from "./initiatives/InitiativeTools";
import { PaletteColorPicker } from "./ProjectAppearanceControls";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { LoadingMark } from "./ui";
import "./InitiativesView.css";

export interface InitiativesViewProps {
  snapshot: AppSnapshot | null;
  settings: Pick<AppSettings, "confirmDestructiveActions"> & InitiativeToolsSettings;
  status: ConnectionStatus;
  selectedInitiativeId: string | null;
  onSelectInitiative(initiativeId: string | null): void;
  request(command: CommandWithoutId, options?: { passive?: boolean }): Promise<ServerEvent>;
  onOpenConversation(conversation: Conversation): void;
  onError(message: string): void;
}

type MemberGroupId = "waiting" | "working" | "done" | "idle";

const MEMBER_GROUPS: readonly { id: MemberGroupId; label: string }[] = [
  { id: "waiting", label: "Waiting on you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
  { id: "idle", label: "Idle" },
];

const MEMBER_STATUS_WORDS: Record<SidebarThreadView["status"], string> = {
  working: "Working",
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  limited: "Limited",
  completed: "Completed",
  idle: "Idle",
};

export function initiativeMemberGroup(thread: SidebarThreadView): MemberGroupId {
  if (thread.status === "working") return "working";
  // A settled chat is done even when its last turn failed, as in the sidebar.
  if (thread.needsAttention && !thread.settled) return "waiting";
  if (thread.settled || thread.status === "completed") return "done";
  return "idle";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type InitiativeUpdate = {
  name?: string;
  color?: InitiativeColor;
  status?: InitiativeStatus;
  preferences?: InitiativePreferencesPatch;
};

/** Later changes win; settings changes merge field by field. */
function mergeUpdates(into: InitiativeUpdate, patch: InitiativeUpdate): void {
  const preferences = into.preferences || patch.preferences
    ? { ...into.preferences, ...patch.preferences }
    : undefined;
  Object.assign(into, patch, preferences ? { preferences } : {});
}

/**
 * Sends this page's initiative commands one at a time. An update reads the
 * newest known revision when it is sent (the snapshot's, or one past this
 * page's last successful update or brief save), so a quick run of the user's
 * own changes, like arrowing through colours, Mark done then Archive, or a
 * brief save then a rename, never conflicts with itself. Updates still waiting
 * to be sent merge into one. The runtime keeps its revision checks, so a
 * change made elsewhere is still reported.
 */
function useInitiativeCommandQueue(
  initiatives: readonly Initiative[],
  request: InitiativesViewProps["request"],
  onError: InitiativesViewProps["onError"],
): {
  /** Resolves with the revision the update produced, or null when it failed. */
  update(initiative: Initiative, patch: InitiativeUpdate): Promise<number | null>;
  /** Saves a changed brief; the caller never sends the text it started from. */
  updateBrief(initiative: Initiative, brief: string, expectedBriefRevision: number): Promise<BriefSaveOutcome>;
  /** Resolves true when the runtime applied the note change. */
  note(command: InitiativeNoteCommand): Promise<boolean>;
  remove(initiative: Initiative): Promise<void>;
} {
  const snapshotRevisions = useRef(new Map<string, number>());
  const confirmedRevisions = useRef(new Map<string, number>());
  const waiting = useRef(new Map<string, { patch: InitiativeUpdate; sent: Promise<number | null> }>());
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const callbacks = useRef({ request, onError });
  useEffect(() => {
    callbacks.current = { request, onError };
    snapshotRevisions.current = new Map(initiatives.map(({ id, revision }) => [id, revision]));
  });
  const enqueue = <T,>(
    send: () => Promise<T>,
    failure: string,
    recover?: (error: unknown) => T | null,
  ): Promise<T | null> => {
    const sent = tail.current.then(send).catch((error: unknown) => {
      const recovered = recover?.(error) ?? null;
      if (recovered === null) callbacks.current.onError(errorMessage(error, failure));
      return recovered;
    });
    tail.current = sent;
    return sent;
  };
  const expectedRevision = (initiative: Initiative): number => Math.max(
    snapshotRevisions.current.get(initiative.id) ?? initiative.revision,
    confirmedRevisions.current.get(initiative.id) ?? 0,
  );
  const update = (initiative: Initiative, patch: InitiativeUpdate): Promise<number | null> => {
    const queued = waiting.current.get(initiative.id);
    if (queued) {
      mergeUpdates(queued.patch, patch);
      return queued.sent;
    }
    const merged: InitiativeUpdate = {};
    mergeUpdates(merged, patch);
    const sent = enqueue(async () => {
      waiting.current.delete(initiative.id);
      const revision = expectedRevision(initiative);
      try {
        const { preferences, ...fields } = merged;
        await callbacks.current.request({
          type: "initiative.update",
          payload: {
            id: initiative.id,
            expectedRevision: revision,
            ...fields,
            ...(preferences ? { preferences: initiativePreferencesPatchSchema.parse(preferences) } : {}),
          },
        }, { passive: true });
      } catch (error) {
        confirmedRevisions.current.delete(initiative.id);
        throw error;
      }
      confirmedRevisions.current.set(initiative.id, revision + 1);
      return revision + 1;
    }, "The initiative could not be updated.");
    waiting.current.set(initiative.id, { patch: merged, sent });
    return sent;
  };
  const updateBrief = async (
    initiative: Initiative,
    brief: string,
    expectedBriefRevision: number,
  ): Promise<BriefSaveOutcome> => {
    const outcome = await enqueue<BriefSaveOutcome>(async () => {
      // A saved brief always changed, so the row revision moves by exactly one.
      const revision = expectedRevision(initiative);
      try {
        await callbacks.current.request({
          type: "initiative.brief.update",
          payload: { id: initiative.id, expectedBriefRevision, brief },
        }, { passive: true });
      } catch (error) {
        confirmedRevisions.current.delete(initiative.id);
        throw error;
      }
      confirmedRevisions.current.set(initiative.id, revision + 1);
      return "saved";
    }, "The brief could not be saved.", (error) => (
      error instanceof Error && error.message === INITIATIVE_BRIEF_CONFLICT_MESSAGE ? "conflict" : null
    ));
    return outcome ?? "failed";
  };
  const note = async (command: InitiativeNoteCommand): Promise<boolean> => {
    const applied = await enqueue(async () => {
      await callbacks.current.request(command, { passive: true });
      return true;
    }, "The note could not be saved.");
    return applied === true;
  };
  const remove = async (initiative: Initiative): Promise<void> => {
    await enqueue(async () => {
      await callbacks.current.request(
        { type: "initiative.delete", payload: { id: initiative.id } },
        { passive: true },
      );
      forgetInitiativeBriefDraft(initiative.id);
    }, "The initiative could not be deleted.");
  };
  return { update, updateBrief, note, remove };
}

function InitiativeName({ initiative, disabled, onRename }: {
  initiative: Initiative;
  disabled: boolean;
  onRename(name: string): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initiative.name);
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const open = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  const finish = (save: boolean, refocus: boolean): void => {
    if (!open.current) return;
    open.current = false;
    const name = draft.trim();
    if (save && name !== initiative.name && isInitiativeName(name)) onRename(name);
    restoreFocus.current = refocus;
    setEditing(false);
  };
  if (editing) {
    return (
      <form className="initiative-name-form" onSubmit={(event) => { event.preventDefault(); finish(true, true); }}>
        <input
          ref={input}
          value={draft}
          maxLength={MAX_INITIATIVE_NAME_CHARS}
          aria-label="Initiative name"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value.replace(/[\t\r\n]/gu, " "))}
          onBlur={() => finish(true, false)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            finish(false, true);
          }}
        />
      </form>
    );
  }
  return (
    <div className="initiative-name-row">
      <h2 className="initiative-detail-name">{initiative.name}</h2>
      <button
        ref={editButton}
        type="button"
        className="text-button initiative-rename"
        aria-label={`Rename ${initiative.name}`}
        disabled={disabled}
        onClick={() => {
          open.current = true;
          setDraft(initiative.name);
          setEditing(true);
        }}
      >
        <Pencil size={14} aria-hidden="true" />Rename
      </button>
    </div>
  );
}

function InitiativeDetail({
  initiative,
  members,
  snapshot,
  settings,
  offline,
  confirmDestructiveActions,
  onUpdate,
  onOpenSkillsFolder,
  onSaveBrief,
  onNoteCommand,
  loadNotes,
  onDelete,
  onOpenConversation,
}: {
  initiative: Initiative;
  members: readonly SidebarThreadView[];
  snapshot: AppSnapshot;
  settings: InitiativeToolsSettings;
  offline: boolean;
  confirmDestructiveActions: boolean;
  onUpdate(patch: InitiativeUpdate): Promise<number | null>;
  onOpenSkillsFolder(): Promise<void>;
  onSaveBrief(brief: string, expectedBriefRevision: number): Promise<BriefSaveOutcome>;
  onNoteCommand(command: InitiativeNoteCommand): Promise<boolean>;
  loadNotes(initiativeId: string): Promise<InitiativeNote[] | null>;
  onDelete(): void;
  onOpenConversation(conversation: Conversation): void;
}): React.JSX.Element {
  // The colour the user last chose stays shown until the snapshot reaches the
  // revision that saved it, so the swatches never step back to an older colour
  // (and an arrow key back to that colour is still sent). A failure reverts.
  const [colorChoice, setColorChoice] = useState<{
    color: InitiativeColor;
    savedRevision: number | null;
  } | null>(null);
  const latestColorUpdate = useRef<Promise<number | null> | null>(null);
  const chooseColor = (color: InitiativeColor): void => {
    setColorChoice({ color, savedRevision: null });
    const sent = onUpdate({ color });
    latestColorUpdate.current = sent;
    void sent.then((revision) => {
      if (latestColorUpdate.current !== sent) return;
      setColorChoice((current) => revision === null || !current ? null : { ...current, savedRevision: revision });
    });
  };
  const shownColor = colorChoice
    && (colorChoice.savedRevision === null || initiative.revision < colorChoice.savedRevision)
    ? colorChoice.color
    : initiative.color;
  const projects = useMemo(
    () => new Map(snapshot.projects.map((project) => [project.id, project])),
    [snapshot.projects],
  );
  const groups = MEMBER_GROUPS.map((group) => ({
    ...group,
    threads: members.filter((thread) => initiativeMemberGroup(thread) === group.id),
  })).filter(({ threads }) => threads.length > 0);
  const count = members.length;
  return (
    <article className="initiative-detail" aria-label={initiative.name}>
      <header className="initiative-detail-header">
        <InitiativeDot color={shownColor} size={12} />
        <InitiativeName
          key={initiative.id}
          initiative={initiative}
          disabled={offline}
          onRename={(name) => void onUpdate({ name })}
        />
      </header>
      <p className="initiative-detail-summary">
        {INITIATIVE_STATUS_LABELS[initiative.status]} · {count === 0 ? "No chats yet" : `${count} ${count === 1 ? "chat" : "chats"}`}
      </p>
      <div className="initiative-detail-controls">
        <PaletteColorPicker
          label="Initiative colour"
          value={shownColor}
          disabled={offline}
          onChange={chooseColor}
        />
        <div className="initiative-detail-actions" role="group" aria-label="Initiative status">
          {initiative.status === "active" && (
            <button type="button" className="secondary-button" disabled={offline} onClick={() => void onUpdate({ status: "done" })}>
              <CircleCheck size={14} aria-hidden="true" />Mark done
            </button>
          )}
          {initiative.status === "done" && (
            <button type="button" className="secondary-button" disabled={offline} onClick={() => void onUpdate({ status: "active" })}>
              <RotateCcw size={14} aria-hidden="true" />Reopen
            </button>
          )}
          {initiative.status === "archived" ? (
            <button type="button" className="secondary-button" disabled={offline} onClick={() => void onUpdate({ status: "active" })}>
              <ArchiveRestore size={14} aria-hidden="true" />Unarchive
            </button>
          ) : (
            <button type="button" className="secondary-button" disabled={offline} onClick={() => void onUpdate({ status: "archived" })}>
              <Archive size={14} aria-hidden="true" />Archive
            </button>
          )}
          <button type="button" className="secondary-button is-danger" disabled={offline} onClick={onDelete}>
            <Trash2 size={14} aria-hidden="true" />Delete
          </button>
        </div>
      </div>
      <InitiativeBrief initiative={initiative} offline={offline} onSave={onSaveBrief} />
      <InitiativeNotes
        initiative={initiative}
        offline={offline}
        confirmDestructiveActions={confirmDestructiveActions}
        loadNotes={loadNotes}
        onCommand={onNoteCommand}
      />
      <section className="initiative-members" aria-label="Chats in this initiative">
        <h3 className="initiative-members-heading">Chats</h3>
        {groups.length === 0 ? (
          <p className="initiative-empty-note">
            Move a chat here from its actions menu, or pick this initiative when you start a new chat.
          </p>
        ) : groups.map((group) => (
          <section key={group.id} className="initiative-member-group" aria-labelledby={`initiative-members-${group.id}`}>
            <h4 id={`initiative-members-${group.id}`}>
              <span>{group.label}</span><span>{group.threads.length}</span>
            </h4>
            <ul>
              {group.threads.map(({ conversation, status }) => {
                const project = projects.get(conversation.projectId);
                const projectLabel = project?.workspaceKind === "scratch" ? "No project" : project?.name ?? "Unknown project";
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={clsx("initiative-member", `status-${status}`)}
                      aria-label={`${conversation.title}, ${projectLabel}, ${MEMBER_STATUS_WORDS[status]}. Open chat`}
                      onClick={() => onOpenConversation(conversation)}
                    >
                      <ProviderBrandIcon providerId={conversation.providerId} size={14} />
                      <span className="initiative-member-title">{conversation.title}</span>
                      <span className="initiative-member-project">
                        <ProjectIcon project={project} size={13} />
                        <span>{projectLabel}</span>
                      </span>
                      <span className="initiative-member-status">{MEMBER_STATUS_WORDS[status]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </section>
      <InitiativeTools
        initiative={initiative}
        snapshot={snapshot}
        settings={settings}
        offline={offline}
        onChange={async (preferences) => await onUpdate({ preferences }) !== null}
        onOpenSkillsFolder={onOpenSkillsFolder}
      />
    </article>
  );
}

export function InitiativesView({
  snapshot,
  settings,
  status,
  selectedInitiativeId,
  onSelectInitiative,
  request,
  onOpenConversation,
  onError,
}: InitiativesViewProps): React.JSX.Element {
  const offline = status !== "online";
  const initiatives = useMemo(
    () => [...(snapshot?.initiatives ?? [])].sort(compareInitiatives),
    [snapshot?.initiatives],
  );
  const selected = initiatives.find(({ id }) => id === selectedInitiativeId)
    ?? initiatives.find(({ status: initiativeStatus }) => initiativeStatus === "active")
    ?? initiatives[0]
    ?? null;
  const threadViews = useMemo(() => sidebarThreadViewMap(
    snapshot?.conversations ?? [],
    snapshot?.activeConversationId ?? null,
    snapshot?.runs ?? [],
  ), [snapshot?.activeConversationId, snapshot?.conversations, snapshot?.runs]);
  const membersByInitiative = useMemo(() => {
    const members = initiativeMembers(
      (snapshot?.conversations ?? []).filter(({ archivedAt }) => archivedAt === null),
      ({ initiativeId }) => initiativeId,
    );
    return new Map([...members].map(([id, conversations]) => [
      id,
      sortSidebarThreadViews(conversations.flatMap((conversation) => {
        const view = threadViews.get(conversation.id);
        return view ? [view] : [];
      })),
    ]));
  }, [snapshot?.conversations, threadViews]);
  const commands = useInitiativeCommandQueue(initiatives, request, onError);
  const loadNotes = async (initiativeId: string): Promise<InitiativeNote[] | null> => {
    try {
      const event = await request({ type: "initiative.notes.list", payload: { initiativeId } }, { passive: true });
      return event.type === "request.result" && event.result.kind === "initiative.notes"
        && event.result.initiativeId === initiativeId
        ? event.result.notes
        : null;
    } catch (error) {
      onError(errorMessage(error, "The notes could not be loaded."));
      return null;
    }
  };
  const createInitiative = (): void => {
    requestNewInitiative({ onCreated: (id) => onSelectInitiative(id) });
  };

  if (!snapshot) {
    return (
      <main className="initiatives-view" aria-labelledby="initiatives-view-heading" aria-busy="true">
        <h1 className="visually-hidden" id="initiatives-view-heading">Initiatives</h1>
        <LoadingMark label="Loading initiatives" />
      </main>
    );
  }

  return (
    <main className="initiatives-view" aria-labelledby="initiatives-view-heading">
      <div className="initiatives-layout">
        <nav className="initiatives-list" aria-labelledby="initiatives-view-heading">
          <header className="initiatives-heading">
            <h1 id="initiatives-view-heading">Initiatives</h1>
            <button type="button" className="secondary-button" disabled={offline} onClick={createInitiative}>
              <Plus size={14} aria-hidden="true" />New initiative
            </button>
          </header>
          {initiatives.length === 0 && (
            <p className="initiative-empty-note">
              An initiative groups chats from any project under one name, so related work stays together in the sidebar.
            </p>
          )}
          {INITIATIVE_STATUSES.map((groupStatus) => {
            const entries = initiatives.filter(({ status: initiativeStatus }) => initiativeStatus === groupStatus);
            if (entries.length === 0) return null;
            return (
              <section key={groupStatus} className="initiatives-list-group" aria-labelledby={`initiatives-group-${groupStatus}`}>
                <h2 id={`initiatives-group-${groupStatus}`}><span>{INITIATIVE_STATUS_LABELS[groupStatus]}</span><span>{entries.length}</span></h2>
                <ul>
                  {entries.map((initiative) => {
                    const count = membersByInitiative.get(initiative.id)?.length ?? 0;
                    return (
                      <li key={initiative.id}>
                        <button
                          type="button"
                          className={clsx("initiatives-list-item", selected?.id === initiative.id && "is-selected")}
                          aria-current={selected?.id === initiative.id ? "true" : undefined}
                          aria-label={`${initiative.name}, ${count} ${count === 1 ? "chat" : "chats"}`}
                          onClick={() => onSelectInitiative(initiative.id)}
                        >
                          <InitiativeDot color={initiative.color} />
                          <span className="initiatives-list-name">{initiative.name}</span>
                          <span className="initiatives-list-count" aria-hidden="true">{count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
        {selected && (
          <InitiativeDetail
            key={selected.id}
            initiative={selected}
            members={membersByInitiative.get(selected.id) ?? []}
            snapshot={snapshot}
            settings={settings}
            offline={offline}
            confirmDestructiveActions={settings.confirmDestructiveActions}
            onUpdate={(patch) => commands.update(selected, patch)}
            onOpenSkillsFolder={async () => {
              try {
                await window.inertia.openInitiativeSkillsFolder(selected.id);
              } catch (error) {
                // Runtime refusals are readable; strip Electron's IPC wrapper.
                const detail = error instanceof Error
                  ? error.message.replace(ELECTRON_IPC_ERROR_PREFIX, "").trim()
                  : "";
                onError(detail || "The skills folder could not be opened.");
              }
            }}
            onSaveBrief={(brief, expectedBriefRevision) => commands.updateBrief(selected, brief, expectedBriefRevision)}
            onNoteCommand={commands.note}
            loadNotes={loadNotes}
            onDelete={() => {
              // Archived chats keep their membership too, so they are counted.
              const count = snapshot.conversations
                .filter(({ initiativeId }) => initiativeId === selected.id).length;
              const prompt = `Delete “${selected.name}”? ${count === 0
                ? "It has no chats."
                : count === 1
                  ? "Its 1 chat keeps its history and leaves the initiative."
                  : `Its ${count} chats keep their history and leave the initiative.`}`;
              if (settings.confirmDestructiveActions && !window.confirm(prompt)) return;
              onSelectInitiative(null);
              void commands.remove(selected);
            }}
            onOpenConversation={onOpenConversation}
          />
        )}
      </div>
    </main>
  );
}
