import { useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Copy, Download, Pencil, Plus, Trash2 } from "lucide-react";

import type { AgentSkillSummary } from "@shared/contracts";
import {
  buildCustomAgentExport,
  MAX_CUSTOM_AGENTS,
  uniqueCustomAgentHandle,
  type CustomAgent,
  type CustomAgentDraft,
  type CustomAgentIconName,
} from "@shared/custom-agents";
import { CUSTOM_AGENT_PRESETS } from "@shared/custom-agent-presets";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { IconButton } from "../ui";
import { SettingNoteStatus, SettingsGroup, SettingStatus } from "../settings/SettingsLayout";
import { useSettingAction } from "../settings/useSettingAction";
import { CustomAgentAvatar } from "./CustomAgentAvatar";
import { CustomAgentEditor } from "./CustomAgentEditor";
import {
  blankCustomAgentDraft,
  customAgentCreateCommand,
  customAgentDraftFromPreset,
  customAgentDraftOf,
  customAgentSummary,
  customAgentUpdateCommand,
  saveFailureMessage,
} from "./customAgentDraft";
import "./CustomAgentsSettings.css";

export interface CustomAgentsSettingsProps {
  agents: readonly CustomAgent[];
  skills: readonly AgentSkillSummary[];
  confirmDestructiveActions: boolean;
  disabled: boolean;
  request?: (command: CommandWithoutId) => Promise<unknown>;
}

type Editing =
  | { kind: "new"; key: string; seed: CustomAgentDraft; linkHandle: boolean }
  | { kind: "edit"; agentId: string; baseline: CustomAgent }
  | null;

interface RowTarget {
  agentId?: string;
  handle?: string;
}

interface PendingMove {
  agentId: string;
  index: number;
  direction: "up" | "down";
}

const COUNT_VISIBLE_FROM = 30;
const GHOST_SYMBOLS: readonly CustomAgentIconName[] = ["orbit", "search", "pen"];
const LIMIT_MESSAGE = `You can keep up to ${MAX_CUSTOM_AGENTS} agents. Delete one to add another.`;

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function bridge(): Window["inertia"] | undefined {
  return typeof window === "undefined" ? undefined : (window as Partial<Window>).inertia;
}

function PresetChips({ disabled, onPick }: { disabled: boolean; onPick: (presetId: string) => void }): React.JSX.Element {
  return (
    <div className="custom-agent-presets" role="group" aria-label="Presets" data-setting-id="custom-agent-presets">
      {CUSTOM_AGENT_PRESETS.map((preset) => (
        <button key={preset.id} type="button" className="custom-agent-preset" disabled={disabled} onClick={() => onPick(preset.id)}>
          <CustomAgentAvatar agent={preset} size={18} />
          {preset.name}
        </button>
      ))}
    </div>
  );
}

export function CustomAgentsSettings({ agents, skills, confirmDestructiveActions, disabled, request }: CustomAgentsSettingsProps): React.JSX.Element {
  const header = useSettingAction();
  const rows = useSettingAction();
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowTarget, setRowTarget] = useState<RowTarget | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const createdHandle = useRef<string | null>(null);
  const pendingMove = useRef<PendingMove | null>(null);

  const ordered = useMemo(() => [...agents].sort((left, right) => left.position - right.position), [agents]);
  const skillNames = useMemo(
    () => [...new Set(skills.filter(({ enabled }) => enabled).map(({ name }) => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [skills],
  );
  const handles = useMemo(() => ordered.map(({ handle }) => handle), [ordered]);
  const unavailable = disabled || !request;
  const full = ordered.length >= MAX_CUSTOM_AGENTS;
  const files = bridge();
  const canImport = typeof files?.importCustomAgents === "function";
  const canExport = typeof files?.exportCustomAgents === "function";
  const rowBusy = rows.busy || undefined;
  const editingAgent = editing?.kind === "edit" && ordered.some(({ id }) => id === editing.agentId) ? editing.baseline : undefined;
  const newEditor = editing?.kind === "new" ? editing : null;

  useLayoutEffect(() => {
    if (confirming) confirmCancel.current?.focus();
  }, [confirming]);
  useLayoutEffect(() => {
    const target = restoreFocus.current;
    if (!target) return;
    restoreFocus.current = null;
    if (target.isConnected) target.focus();
    else newButton.current?.focus();
  });
  useLayoutEffect(() => {
    const handle = createdHandle.current;
    const created = handle ? ordered.find((agent) => agent.handle === handle) : undefined;
    if (!created) return;
    createdHandle.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active !== newButton.current) return;
    rowButton(created.id, "edit")?.focus();
  });
  useLayoutEffect(() => {
    const move = pendingMove.current;
    if (!move || ordered[move.index]?.id !== move.agentId) return;
    pendingMove.current = null;
    if (!document.activeElement || document.activeElement === document.body) rowButton(move.agentId, move.direction)?.focus();
  });

  function rowButton(agentId: string, action: "up" | "down" | "edit"): HTMLButtonElement | null {
    return list.current?.querySelector<HTMLButtonElement>(`[data-agent-id="${CSS.escape(agentId)}"] [data-row-action="${action}"]`) ?? null;
  }
  const send = async (command: CommandWithoutId): Promise<void> => {
    if (unavailable || !request) throw new Error("Custom agents are unavailable right now.");
    await request(command);
  };
  const closeEditor = (focus = true): void => {
    setEditing(null);
    if (focus) restoreFocus.current = opener.current;
  };
  const openNew = (seed: CustomAgentDraft, linkHandle: boolean, trigger: HTMLElement | null): void => {
    if (unavailable) return;
    if (full) {
      header.report({ tone: "error", text: LIMIT_MESSAGE });
      return;
    }
    opener.current = trigger;
    setConfirming(null);
    setEditing({ kind: "new", key: crypto.randomUUID(), seed, linkHandle });
  };
  const openPreset = (presetId: string, trigger: HTMLElement | null): void => {
    const preset = CUSTOM_AGENT_PRESETS.find(({ id }) => id === presetId);
    if (preset) openNew(customAgentDraftFromPreset(preset, handles), true, trigger);
  };
  const rowAction = (target: RowTarget, operation: () => Promise<void>, success: string | null): Promise<boolean> => {
    if (unavailable || rows.busy) return Promise.resolve(false);
    setRowTarget(target);
    return rows.run(operation, { success, failure: saveFailureMessage });
  };
  const rowNotice = (agent: CustomAgent) => rowTarget && (rowTarget.agentId === agent.id || rowTarget.handle === agent.handle) ? rows.notice : null;
  const move = (index: number, offset: number): void => {
    const target = index + offset;
    if (target < 0 || target >= ordered.length) return;
    const agentIds = ordered.map(({ id }) => id);
    const [moved] = agentIds.splice(index, 1);
    agentIds.splice(target, 0, moved!);
    const pending = { agentId: moved!, index: target, direction: offset < 0 ? "up" as const : "down" as const };
    pendingMove.current = pending;
    void rowAction({ agentId: moved }, () => send({
      type: "custom-agent.reorder",
      payload: { expectedAgentIds: ordered.map(({ id }) => id), agentIds },
    }), null).then((saved) => {
      if (!saved && pendingMove.current === pending) pendingMove.current = null;
    });
  };
  const remove = (agent: CustomAgent): void => {
    if (unavailable || rows.busy) return;
    setConfirming(null);
    setRowTarget(null);
    if (editing?.kind === "edit" && editing.agentId === agent.id) setEditing(null);
    void header.run(() => send({ type: "custom-agent.delete", payload: { agentId: agent.id, expectedRevision: agent.revision } }), {
      success: `Deleted ${agent.name}`,
      failure: saveFailureMessage,
    }).then((deleted) => {
      if (deleted) newButton.current?.focus();
    });
  };
  const exportAgents = (list: readonly CustomAgent[], target: RowTarget | null): void => {
    const exporter = files?.exportCustomAgents;
    if (!exporter || list.length === 0) return;
    const action = target ? rows : header;
    if (target) setRowTarget(target);
    void action.run(async () => {
      const result = await exporter(buildCustomAgentExport(list.map(customAgentDraftOf)));
      if (result.status === "rejected") throw new Error(result.message);
      return result.status;
    }, {
      key: "export",
      success: (status) => status === "exported" ? `Exported ${list.length === 1 ? list[0]!.name : plural(list.length, "agent")}` : null,
      failure: (error) => error instanceof Error && error.message ? error.message : "The agents could not be exported.",
    });
  };
  const importAgents = (): void => {
    const importer = files?.importCustomAgents;
    if (!importer || unavailable || header.busy) return;
    void header.run(async () => {
      const result = await importer();
      if (result.status === "cancelled") return null;
      if (result.status === "rejected") throw new Error(result.message);
      const room = MAX_CUSTOM_AGENTS - ordered.length;
      if (room <= 0) throw new Error(LIMIT_MESSAGE);
      const taken = new Set(handles);
      const accepted = result.agents.slice(0, room);
      const renamed: string[] = [];
      let imported = 0;
      for (const agent of accepted) {
        const handle = uniqueCustomAgentHandle(agent.handle, taken);
        taken.add(handle);
        if (handle !== agent.handle) renamed.push(`/calling ${agent.handle} → ${handle}`);
        try {
          await send(customAgentCreateCommand({ ...agent, handle }, "rename"));
        } catch (error) {
          const reason = saveFailureMessage(error);
          throw new Error(imported > 0 ? `Imported ${imported} of ${accepted.length} agents. ${reason}` : reason);
        }
        imported += 1;
      }
      const parts = [`Imported ${plural(imported, "agent")}`];
      if (renamed.length > 0) parts.push(`renamed ${renamed.join(", ")}`);
      const skipped = result.agents.length - accepted.length;
      if (skipped > 0) parts.push(`${plural(skipped, "agent")} skipped at the ${MAX_CUSTOM_AGENTS}-agent limit`);
      return parts.join("; ");
    }, {
      key: "import",
      success: (text) => text,
      failure: (error) => error instanceof Error && error.message ? error.message : "The agents could not be imported.",
    });
  };
  const saveNew = async (agent: CustomAgentDraft): Promise<void> => {
    await send(customAgentCreateCommand(agent, "reject"));
    closeEditor(false);
    restoreFocus.current = newButton.current;
    createdHandle.current = agent.handle;
    setRowTarget({ handle: agent.handle });
    rows.report({ tone: "saved", text: "Saved" });
  };
  const saveExisting = (baseline: CustomAgent) => async (agent: CustomAgentDraft): Promise<void> => {
    const command = customAgentUpdateCommand(baseline, agent);
    if (command) await send(command);
    restoreFocus.current = opener.current;
    setEditing(null);
    setRowTarget({ agentId: baseline.id });
    if (command) rows.report({ tone: "saved", text: "Saved" });
  };

  const editor = (agent: CustomAgent | null) => {
    if (agent) {
      return (
        <CustomAgentEditor
          key={agent.id}
          label={`Edit ${agent.name}`}
          initial={customAgentDraftOf(agent)}
          linkHandle={false}
          otherHandles={handles.filter((handle) => handle !== agent.handle)}
          skills={skillNames}
          disabled={unavailable}
          onCancel={() => closeEditor()}
          onSave={saveExisting(editingAgent ?? agent)}
        />
      );
    }
    if (!newEditor) return null;
    return (
      <CustomAgentEditor
        key={newEditor.key}
        label="New agent"
        initial={newEditor.seed}
        linkHandle={newEditor.linkHandle}
        otherHandles={handles}
        skills={skillNames}
        disabled={unavailable}
        onCancel={() => closeEditor()}
        onSave={saveNew}
      />
    );
  };

  return (
    <div className="custom-agents-settings">
      <SettingsGroup
        title="Custom agents"
        titleHidden
        className="custom-agents-card"
        description="Agents you call by name. Each one carries its own instructions into a subagent, so your chat keeps its context."
      >
        <div className="custom-agents-toolbar">
          <span className="custom-agents-toolbar-item" data-setting-id="custom-agent-new">
            <button
              ref={newButton}
              type="button"
              className="primary-button"
              disabled={unavailable}
              aria-disabled={full || undefined}
              aria-expanded={newEditor ? true : false}
              onClick={(event) => {
                if (newEditor) return;
                openNew(blankCustomAgentDraft(), true, event.currentTarget);
              }}
            >
              <Plus size={14} aria-hidden="true" />New agent
            </button>
          </span>
          <span className="custom-agents-toolbar-item" data-setting-id="custom-agent-import">
            <button type="button" className="secondary-button" disabled={unavailable || !canImport} aria-disabled={header.busy || undefined} onClick={importAgents}>
              <span>Import<span className="visually-hidden"> agents</span>…</span>
            </button>
          </span>
          <span className="custom-agents-toolbar-item" data-setting-id="custom-agent-export">
            <button
              type="button"
              className="secondary-button"
              disabled={!canExport || ordered.length === 0}
              aria-disabled={header.busy || undefined}
              onClick={() => { if (!header.busy) exportAgents(ordered, null); }}
            >
              <span>Export all<span className="visually-hidden"> agents</span></span>
            </button>
          </span>
          {ordered.length >= COUNT_VISIBLE_FROM && (
            <small className="custom-agents-count">{ordered.length} of {MAX_CUSTOM_AGENTS}</small>
          )}
        </div>
        <SettingNoteStatus notice={header.notice} />

        {ordered.length === 0 && !newEditor && (
          <div className="custom-agents-empty">
            <span className="custom-agents-empty-avatars" aria-hidden="true">
              {GHOST_SYMBOLS.map((name) => (
                <CustomAgentAvatar key={name} agent={{ name, icon: { kind: "symbol", name }, accent: null }} size={32} />
              ))}
            </span>
            <strong>No agents yet</strong>
            <small>Start from a preset or build your own.</small>
            <PresetChips disabled={unavailable} onPick={(presetId) => openPreset(presetId, document.activeElement as HTMLElement | null)} />
          </div>
        )}

        {(ordered.length > 0 || newEditor) && (
          <ul ref={list} className="custom-agent-list" aria-label="Custom agents">
            {newEditor && <li className="custom-agent-row is-new is-open">{editor(null)}</li>}
            {ordered.map((agent, index) => {
              const open = editingAgent?.id === agent.id;
              return (
                <li key={agent.id} className={clsx("custom-agent-row", open && "is-open")} data-agent-id={agent.id}>
                  <div className="custom-agent-row-summary">
                    <CustomAgentAvatar agent={agent} size={32} />
                    <span className="custom-agent-row-copy">
                      <span className="custom-agent-row-title">
                        <strong>{agent.name}</strong>
                        <code className="custom-agent-handle">/calling {agent.handle}</code>
                        <SettingStatus notice={rowNotice(agent)} />
                      </span>
                      {agent.description && <small className="custom-agent-row-description">{agent.description}</small>}
                      <small className="custom-agent-row-meta">{customAgentSummary(agent)}</small>
                    </span>
                    <div className="custom-agent-row-actions" role="group" aria-label={`${agent.name} actions`}>
                      <IconButton label={`Move ${agent.name} up`} data-row-action="up" disabled={unavailable} aria-disabled={index === 0 || rowBusy} onClick={() => move(index, -1)}>
                        <ArrowUp size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Move ${agent.name} down`} data-row-action="down" disabled={unavailable} aria-disabled={index === ordered.length - 1 || rowBusy} onClick={() => move(index, 1)}>
                        <ArrowDown size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={`Edit ${agent.name}`}
                        data-row-action="edit"
                        disabled={unavailable}
                        aria-expanded={open}
                        onClick={(event) => {
                          if (open) {
                            closeEditor();
                            return;
                          }
                          opener.current = event.currentTarget;
                          setConfirming(null);
                          setEditing({ kind: "edit", agentId: agent.id, baseline: agent });
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={`Duplicate ${agent.name}`}
                        disabled={unavailable}
                        aria-disabled={full || rowBusy}
                        onClick={() => {
                          if (full) {
                            setRowTarget({ agentId: agent.id });
                            rows.report({ tone: "error", text: LIMIT_MESSAGE });
                            return;
                          }
                          rowAction({ agentId: agent.id }, () => send({
                            type: "custom-agent.duplicate",
                            payload: { agentId: agent.id, expectedRevision: agent.revision },
                          }), "Duplicated");
                        }}
                      >
                        <Copy size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Export ${agent.name}`} disabled={!canExport} aria-disabled={rowBusy} onClick={() => { if (!rows.busy) exportAgents([agent], { agentId: agent.id }); }}>
                        <Download size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={`Delete ${agent.name}`}
                        disabled={unavailable}
                        aria-disabled={rowBusy}
                        aria-expanded={confirmDestructiveActions ? confirming === agent.id : undefined}
                        onClick={(event) => {
                          if (rows.busy) return;
                          if (!confirmDestructiveActions) {
                            remove(agent);
                            return;
                          }
                          opener.current = event.currentTarget;
                          setConfirming(confirming === agent.id ? null : agent.id);
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                  {confirming === agent.id && (
                    <div
                      className="custom-agent-confirm"
                      role="group"
                      aria-label={`Confirm deleting ${agent.name}`}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        event.stopPropagation();
                        setConfirming(null);
                        restoreFocus.current = opener.current;
                      }}
                    >
                      <strong>Delete “{agent.name}”?</strong>
                      <small>/calling {agent.handle} stops working. This cannot be undone.</small>
                      <div>
                        <button
                          ref={confirmCancel}
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setConfirming(null);
                            restoreFocus.current = opener.current;
                          }}
                        >
                          Cancel
                        </button>
                        <button type="button" className="secondary-button is-danger" disabled={unavailable} onClick={() => remove(agent)}>
                          Delete agent
                        </button>
                      </div>
                    </div>
                  )}
                  {open && editor(agent)}
                </li>
              );
            })}
          </ul>
        )}

        {ordered.length > 0 && (
          <div className="custom-agents-presets-row">
            <small>Start from a preset</small>
            <PresetChips disabled={unavailable} onPick={(presetId) => openPreset(presetId, document.activeElement as HTMLElement | null)} />
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
