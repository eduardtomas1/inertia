import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Initiative, InitiativeMcpServer, InitiativePreferencesPatch } from "@shared/contracts";
import {
  INITIATIVE_MCP_SUPPORT_TEXT,
  MAX_INITIATIVE_MCP_SERVERS,
  initiativeMcpSecretSlot,
  initiativeMcpSecretValueProblem,
  initiativeMcpServerDestination,
  initiativeMcpServerSchema,
  initiativeMcpServersSchema,
  initiativeMcpTransportSecretSlots,
  isInitiativeMcpCredentialName,
  isInitiativeMcpSecretOnlyHeader,
  isSecretInitiativeMcpEntry,
  type InitiativeMcpSecretState,
  type InitiativeMcpSecretStateRequest,
  type SetInitiativeMcpSecretRequest,
} from "@shared/initiative-mcp";

import { Switch } from "../ui";
import "./InitiativeMcpServers.css";

/** The privileged secret path; `window.inertia` in the app, a fake in tests. */
export interface InitiativeMcpSecretBridge {
  setInitiativeMcpSecret(request: SetInitiativeMcpSecretRequest): Promise<InitiativeMcpSecretState>;
  getInitiativeMcpSecretState(request: InitiativeMcpSecretStateRequest): Promise<InitiativeMcpSecretState>;
}

export interface InitiativeMcpServersProps {
  initiative: Initiative;
  offline: boolean;
  /** Resolves true when the runtime saved the change; failures are reported by the page. */
  onChange(patch: InitiativePreferencesPatch): Promise<boolean>;
  secrets?: InitiativeMcpSecretBridge;
}

type EntryKind = "header" | "env";

interface DraftEntry {
  key: string;
  name: string;
  secret: boolean;
  /** A plain value, or a newly typed secret; a stored secret is never read back. */
  value: string;
  /** The entry's secret as stored, when the server already had it. */
  storedSecret: boolean;
  /** The user chose to type a new value for a stored secret. */
  replacing: boolean;
  /** The user ticked or unticked Secret, so the name no longer decides it. */
  secretChosen: boolean;
}

interface Draft {
  /** The server being edited, or null for a new one. */
  original: InitiativeMcpServer | null;
  name: string;
  kind: "http" | "stdio";
  url: string;
  command: string;
  args: string;
  entries: DraftEntry[];
}

type SecretSlots = Record<string, Record<string, boolean>>;

function defaultBridge(): InitiativeMcpSecretBridge | undefined {
  // Absent outside the desktop app (and in older preloads); the card then
  // cannot store secrets and says so.
  const bridge = (typeof window === "undefined" ? undefined : window.inertia) as Partial<InitiativeMcpSecretBridge> | undefined;
  return typeof bridge?.setInitiativeMcpSecret === "function" && typeof bridge.getInitiativeMcpSecretState === "function"
    ? bridge as InitiativeMcpSecretBridge
    : undefined;
}

function entryKind(kind: Draft["kind"]): EntryKind {
  return kind === "http" ? "header" : "env";
}

let entryKeys = 0;
function nextEntryKey(): string {
  entryKeys += 1;
  return `entry-${entryKeys}`;
}

function emptyDraft(): Draft {
  return { original: null, name: "", kind: "http", url: "", command: "", args: "", entries: [] };
}

function draftFor(server: InitiativeMcpServer): Draft {
  const transport = server.transport;
  const entries = transport.kind === "http" ? transport.headers : transport.env;
  return {
    original: server,
    name: server.name,
    kind: transport.kind,
    url: transport.kind === "http" ? transport.url : "",
    command: transport.kind === "stdio" ? transport.command : "",
    args: transport.kind === "stdio" ? transport.args.join("\n") : "",
    entries: entries.map((entry) => ({
      key: nextEntryKey(),
      name: entry.name,
      secret: isSecretInitiativeMcpEntry(entry),
      value: isSecretInitiativeMcpEntry(entry) ? "" : entry.value,
      storedSecret: isSecretInitiativeMcpEntry(entry),
      replacing: false,
      secretChosen: true,
    })),
  };
}

function draftTransport(draft: Draft): InitiativeMcpServer["transport"] {
  const entries = draft.entries.map((entry) => entry.secret
    ? { name: entry.name.trim(), secret: true as const }
    : { name: entry.name.trim(), value: entry.value });
  return draft.kind === "http"
    ? { kind: "http", url: draft.url.trim(), headers: entries }
    : {
        kind: "stdio",
        command: draft.command.trim(),
        args: draft.args.split("\n").map((arg) => arg.replace(/\r$/u, "")).filter((arg) => arg.trim() !== ""),
        env: entries,
      };
}

/**
 * Whether an edited server's stored secrets still apply. They were entered for
 * its URL or command; the vault keeps them under that destination, so a server
 * sent elsewhere starts without them and the form asks for them again.
 */
function storedSecretsApply(draft: Draft): boolean {
  return draft.original !== null
    && draft.original.transport.kind === draft.kind
    && initiativeMcpServerDestination(draft.original) === initiativeMcpServerDestination({ transport: draftTransport(draft) });
}

/** Header names whose value is always a credential: Secret stays ticked. */
function secretOnly(kind: EntryKind, name: string): boolean {
  return kind === "header" && isInitiativeMcpSecretOnlyHeader(name);
}

function firstIssue(result: { success: boolean; error?: { issues: { message: string }[] } }): string | null {
  return result.success ? null : result.error?.issues[0]?.message ?? "Check the server's settings.";
}

function serverSummary(server: InitiativeMcpServer): string {
  return server.transport.kind === "http"
    ? server.transport.url
    : [server.transport.command, ...server.transport.args].join(" ");
}

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * The initiative's MCP servers, in Tools & defaults. Each provider that takes
 * external MCP configuration receives them for every chat here. A header or
 * variable can be marked secret: its value goes once to the system's secure
 * storage through the desktop app and is shown afterwards only as Set.
 */
export function InitiativeMcpServers({
  initiative,
  offline,
  onChange,
  secrets = defaultBridge(),
}: InitiativeMcpServersProps): React.JSX.Element {
  const headingId = useId();
  const stored = initiative.preferences.mcpServers;
  // The list as last saved here, until a newer snapshot arrives: each change
  // is the whole list, so a second quick change must start from the first.
  // Any snapshot with a newer revision (this change's or another window's)
  // wins over it.
  const [saved, setSaved] = useState<{ servers: InitiativeMcpServer[]; revision: number } | null>(null);
  const servers = saved && saved.revision === initiative.revision ? saved.servers : stored;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = offline || saving;
  const [removing, setRemoving] = useState<string | null>(null);
  const [secretSlots, setSecretSlots] = useState<SecretSlots>({});
  const [refreshToken, setRefreshToken] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAdd = (): void => { requestAnimationFrame(() => addButton.current?.focus()); };

  // Which secret slots hold a value, asked of the desktop app per server. Only
  // booleans come back; the values never reach this page.
  // The secrets are kept per destination, so each request names the server's
  // transport as stored.
  const slotKey = useMemo(() => JSON.stringify(servers
    .map((server) => [server.id, server.transport, initiativeMcpTransportSecretSlots(server.transport)] as const)
    .filter(([, , slots]) => slots.length > 0)), [servers]);
  useEffect(() => {
    if (!secrets) return;
    let cancelled = false;
    const wanted = JSON.parse(slotKey) as [string, InitiativeMcpServer["transport"], string[]][];
    void Promise.all(wanted.map(async ([serverId, transport, slots]) => {
      try {
        const state = await secrets.getInitiativeMcpSecretState({ initiativeId: initiative.id, serverId, transport, slots });
        return [serverId, state.slots] as const;
      } catch {
        return [serverId, {}] as const;
      }
    })).then((states) => {
      if (!cancelled) setSecretSlots(Object.fromEntries(states));
    });
    return () => { cancelled = true; };
  }, [initiative.id, refreshToken, secrets, slotKey]);

  useEffect(() => {
    if (saved && saved.revision !== initiative.revision) setSaved(null);
  }, [saved, initiative.revision]);

  const save = async (next: InitiativeMcpServer[]): Promise<boolean> => {
    const parsed = initiativeMcpServersSchema.safeParse(next);
    const issue = firstIssue(parsed);
    if (issue) {
      setProblem(issue);
      return false;
    }
    const applied = await onChange({ mcpServers: next });
    setSaved(applied ? { servers: next, revision: initiative.revision } : null);
    return applied;
  };

  const saveList = (next: InitiativeMcpServer[]): void => {
    setSaving(true);
    setProblem(null);
    void save(next).finally(() => setSaving(false));
  };

  const submit = async (): Promise<void> => {
    if (!draft || saving) return;
    const keeps = storedSecretsApply(draft);
    const server: InitiativeMcpServer = {
      id: draft.original?.id ?? randomId(),
      name: draft.name.trim(),
      enabled: draft.original?.enabled ?? true,
      transport: draftTransport(draft),
    };
    const issue = firstIssue(initiativeMcpServerSchema.safeParse(server));
    if (issue) {
      setProblem(issue);
      return;
    }
    const kind = entryKind(draft.kind);
    const missing = draft.entries.find((entry) => entry.secret && entry.value === ""
      && !(keeps && entry.storedSecret && !entry.replacing));
    if (missing) {
      setProblem(`Enter the secret value for ${missing.name.trim()}.`);
      return;
    }
    for (const entry of draft.entries) {
      const valueProblem = entry.secret && entry.value !== "" ? initiativeMcpSecretValueProblem(entry.value) : null;
      if (valueProblem) {
        setProblem(`${entry.name.trim()}: ${valueProblem}`);
        return;
      }
    }
    const next = draft.original
      ? servers.map((existing) => existing.id === draft.original!.id ? server : existing)
      : [...servers, server];
    setSaving(true);
    setProblem(null);
    try {
      if (!await save(next)) return;
      // The server is saved first; its new secrets go to secure storage after,
      // because the runtime clears a newly added slot before it can be used.
      const failures: string[] = [];
      for (const entry of draft.entries) {
        if (!entry.secret || entry.value === "") continue;
        if (!secrets) {
          failures.push("Secure storage is only available in the desktop app.");
          break;
        }
        try {
          await secrets.setInitiativeMcpSecret({
            initiativeId: initiative.id,
            serverId: server.id,
            transport: server.transport,
            slot: initiativeMcpSecretSlot(kind, entry.name.trim()),
            value: entry.value,
          });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : "The secret could not be saved.");
        }
      }
      setRefreshToken((token) => token + 1);
      if (failures.length > 0) {
        setProblem(`The server was saved, but a secret was not: ${failures[0]}`);
        // Keep the form open on the saved server so the secret can be set again.
        setDraft(draftFor(server));
        return;
      }
      setDraft(null);
      focusAdd();
    } finally {
      setSaving(false);
    }
  };

  const cancel = (): void => {
    setDraft(null);
    setProblem(null);
    focusAdd();
  };

  return (
    <section className="initiative-mcp" aria-labelledby={headingId}>
      <header className="initiative-mcp-heading">
        <h4 id={headingId}>MCP servers</h4>
        <span className="initiative-mcp-count">{servers.length} of {MAX_INITIATIVE_MCP_SERVERS}</span>
      </header>
      <p className="initiative-mcp-hint">
        Every chat in this initiative gets these servers, beside the provider's own. Changes reach each chat with its next message.
      </p>
      <p className="initiative-mcp-support">Works with {INITIATIVE_MCP_SUPPORT_TEXT}</p>
      {servers.length === 0 && !draft && (
        <p className="initiative-mcp-empty">No MCP servers. Your own provider servers stay available as they are.</p>
      )}
      {servers.length > 0 && (
        <ul className="initiative-mcp-list" aria-label="MCP servers for this initiative">
          {servers.map((server) => {
            const entries = server.transport.kind === "http" ? server.transport.headers : server.transport.env;
            const kind: EntryKind = server.transport.kind === "http" ? "header" : "env";
            const unset = entries.filter(isSecretInitiativeMcpEntry)
              .filter(({ name }) => secretSlots[server.id]?.[initiativeMcpSecretSlot(kind, name)] === false);
            if (draft?.original?.id === server.id) return null;
            return (
              <li key={server.id} className="initiative-mcp-server" data-enabled={server.enabled}>
                <div className="initiative-mcp-server-text">
                  <span className="initiative-mcp-server-name">{server.name}</span>
                  <span className="initiative-mcp-server-kind">{server.transport.kind === "http" ? "HTTP" : "Command"}</span>
                  <span className="initiative-mcp-server-summary" title={serverSummary(server)}>{serverSummary(server)}</span>
                  {unset.length > 0 && (
                    <span className="initiative-mcp-server-warning">
                      Secret not set: {unset.map(({ name }) => name).join(", ")}. The server is left out until it is.
                    </span>
                  )}
                </div>
                <div className="initiative-mcp-server-actions">
                  {removing === server.id ? (
                    <>
                      <span className="initiative-mcp-confirm">Remove {server.name} and its secrets?</span>
                      <button
                        type="button"
                        className="text-button is-danger"
                        disabled={busy}
                        onClick={() => {
                          setRemoving(null);
                          saveList(servers.filter(({ id }) => id !== server.id));
                          focusAdd();
                        }}
                      >
                        Remove
                      </button>
                      <button
                        ref={keepButton}
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setRemoving(null);
                          requestAnimationFrame(() => removeButtons.current.get(server.id)?.focus());
                        }}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <Switch
                        label={`Use ${server.name}`}
                        checked={server.enabled}
                        disabled={busy || draft !== null}
                        onChange={(enabled) => {
                          saveList(servers.map((existing) => existing.id === server.id ? { ...existing, enabled } : existing));
                        }}
                      />
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Edit ${server.name}`}
                        disabled={busy || draft !== null}
                        onClick={() => {
                          setProblem(null);
                          setDraft(draftFor(server));
                        }}
                      >
                        Edit
                      </button>
                      <button
                        ref={(button) => {
                          if (button) removeButtons.current.set(server.id, button);
                          else removeButtons.current.delete(server.id);
                        }}
                        type="button"
                        className="text-button is-danger"
                        aria-label={`Remove ${server.name}`}
                        disabled={busy || draft !== null}
                        onClick={() => {
                          setRemoving(server.id);
                          // The confirmation replaces this button: focus its safe choice.
                          requestAnimationFrame(() => keepButton.current?.focus());
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {draft ? (
        <ServerForm
          draft={draft}
          problem={problem}
          saving={saving}
          offline={offline}
          secretSlots={draft.original ? secretSlots[draft.original.id] ?? {} : {}}
          onChange={(next) => {
            setDraft(next);
            if (problem) setProblem(null);
          }}
          onSubmit={() => { void submit(); }}
          onCancel={cancel}
        />
      ) : (
        <div className="initiative-mcp-footer">
          {problem && <p className="initiative-mcp-problem" role="alert">{problem}</p>}
          <button
            ref={addButton}
            type="button"
            className="secondary-button"
            disabled={busy || servers.length >= MAX_INITIATIVE_MCP_SERVERS}
            onClick={() => {
              setProblem(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus size={14} aria-hidden="true" />Add MCP server
          </button>
        </div>
      )}
    </section>
  );
}

function ServerForm({
  draft,
  problem,
  saving,
  offline,
  secretSlots,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  problem: string | null;
  saving: boolean;
  offline: boolean;
  secretSlots: Record<string, boolean>;
  onChange(draft: Draft): void;
  onSubmit(): void;
  onCancel(): void;
}): React.JSX.Element {
  const problemId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const initial = useRef(draft);
  useEffect(() => { nameInput.current?.focus(); }, []);
  const kind = entryKind(draft.kind);
  const keeps = storedSecretsApply(draft);
  const entryLabel = kind === "header" ? "Header" : "Variable";
  const changed = draft !== initial.current;
  const valueInputs = useRef(new Map<string, HTMLInputElement>());
  const updateEntry = (key: string, patch: Partial<DraftEntry>): void => {
    onChange({ ...draft, entries: draft.entries.map((entry) => entry.key === key ? { ...entry, ...patch } : entry) });
  };
  const renameEntry = (entry: DraftEntry, name: string): void => {
    // A credential-shaped name turns Secret on until the user chooses
    // otherwise; Authorization, Proxy-Authorization and Cookie are always secret.
    // A typed value is kept when it becomes secret and cleared when it would
    // otherwise show as plain text.
    const secret = secretOnly(kind, name) || (entry.secretChosen ? entry.secret : isInitiativeMcpCredentialName(name));
    updateEntry(entry.key, { name, ...(secret !== entry.secret ? { secret, ...(secret ? {} : { value: "" }) } : {}) });
  };
  // Escape and Cancel behave alike: a changed form asks before it closes.
  const cancel = (): void => {
    if (!changed || window.confirm("Discard this server's changes?")) onCancel();
  };
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  return (
    <form
      className="initiative-mcp-form"
      aria-label={draft.original ? `Edit ${draft.original.name}` : "Add MCP server"}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="initiative-mcp-fields">
        <label className="initiative-mcp-field">
          <span>Name</span>
          <input
            ref={nameInput}
            className="setting-input"
            aria-label="Server name"
            autoComplete="off"
            spellCheck={false}
            placeholder="tracker"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="initiative-mcp-field">
          <span>Connection</span>
          <select
            className="setting-select"
            aria-label="Connection"
            value={draft.kind}
            onChange={(event) => {
              const next = event.target.value as Draft["kind"];
              // Headers and variables do not carry over between connection kinds.
              onChange({ ...draft, kind: next, entries: next === draft.kind ? draft.entries : [] });
            }}
          >
            <option value="http">HTTP (URL)</option>
            <option value="stdio">Command (stdio)</option>
          </select>
        </label>
      </div>
      {draft.kind === "http" ? (
        <label className="initiative-mcp-field">
          <span>URL</span>
          <input
            className="setting-input"
            type="url"
            aria-label="Server URL"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://mcp.example.com/mcp"
            value={draft.url}
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="initiative-mcp-field">
            <span>Command</span>
            <input
              className="setting-input"
              aria-label="Command"
              autoComplete="off"
              spellCheck={false}
              placeholder="npx"
              value={draft.command}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
            />
          </label>
          <label className="initiative-mcp-field">
            <span>Arguments, one per line</span>
            <textarea
              className="setting-input initiative-mcp-args"
              aria-label="Arguments, one per line"
              rows={2}
              spellCheck={false}
              value={draft.args}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
            />
          </label>
          <p className="initiative-mcp-hint">The provider starts the command itself, without a shell.</p>
        </>
      )}
      <fieldset className="initiative-mcp-entries">
        <legend>{kind === "header" ? "Headers" : "Environment variables"}</legend>
        {draft.original && !keeps && draft.entries.some((entry) => entry.storedSecret) && (
          <p className="initiative-mcp-hint">Secrets stay with the address they were entered for: enter them again for this one.</p>
        )}
        {draft.entries.map((entry) => {
          const label = entry.name.trim() || `this ${entryLabel.toLowerCase()}`;
          const stored = keeps && entry.storedSecret && !entry.replacing;
          const isSet = secretSlots[initiativeMcpSecretSlot(kind, entry.name.trim())] === true;
          return (
            <div key={entry.key} className="initiative-mcp-entry">
              <input
                className="setting-input"
                aria-label={`${entryLabel} name`}
                autoComplete="off"
                spellCheck={false}
                placeholder={kind === "header" ? "Authorization" : "API_TOKEN"}
                value={entry.name}
                disabled={entry.storedSecret && keeps}
                onChange={(event) => renameEntry(entry, event.target.value)}
              />
              {stored ? (
                <span className="initiative-mcp-secret-state">
                  <span>{isSet ? "Set" : "Not set"}</span>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Replace the secret ${label}`}
                    onClick={() => {
                      updateEntry(entry.key, { replacing: true, value: "" });
                      // The value field takes this button's place: keep the focus there.
                      requestAnimationFrame(() => valueInputs.current.get(entry.key)?.focus());
                    }}
                  >
                    {isSet ? "Replace" : "Set"}
                  </button>
                </span>
              ) : (
                <input
                  ref={(input) => {
                    if (input) valueInputs.current.set(entry.key, input);
                    else valueInputs.current.delete(entry.key);
                  }}
                  className="setting-input"
                  type={entry.secret ? "password" : "text"}
                  aria-label={`Value of ${label}`}
                  autoComplete={entry.secret ? "new-password" : "off"}
                  spellCheck={false}
                  value={entry.value}
                  onChange={(event) => updateEntry(entry.key, { value: event.target.value })}
                />
              )}
              <label className="initiative-mcp-secret-toggle">
                <input
                  type="checkbox"
                  aria-label={`Keep ${label} secret`}
                  checked={entry.secret}
                  disabled={stored || secretOnly(kind, entry.name)}
                  onChange={(event) => updateEntry(entry.key, { secret: event.target.checked, value: "", secretChosen: true })}
                />
                Secret
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${label}`}
                onClick={() => onChange({ ...draft, entries: draft.entries.filter(({ key }) => key !== entry.key) })}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="text-button"
          onClick={() => onChange({
            ...draft,
            entries: [...draft.entries, {
              key: nextEntryKey(), name: "", secret: false, value: "", storedSecret: false, replacing: false, secretChosen: false,
            }],
          })}
        >
          <Plus size={14} aria-hidden="true" />{kind === "header" ? "Add header" : "Add variable"}
        </button>
        <p className="initiative-mcp-hint">
          A secret is kept in your system's secure storage, never shown again, and given only to the provider.
        </p>
      </fieldset>
      {problem && <p className="initiative-mcp-problem" id={problemId} role="alert">{problem}</p>}
      <div className="initiative-mcp-buttons">
        <button type="button" className="secondary-button" onClick={cancel}>Cancel</button>
        <button
          type="submit"
          className="primary-button"
          aria-describedby={problem ? problemId : undefined}
          disabled={saving || offline}
        >
          {draft.original ? "Save server" : "Add server"}
        </button>
      </div>
    </form>
  );
}
