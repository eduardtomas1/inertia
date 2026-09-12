import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import type { AppSettings, Conversation, Project, ProviderInfo, ModelBackendDefault, ModelBackendProfileView, ModelSelection } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { defaultProjectPreferences, isValidClaudeTurnBudgetUsd, PROJECT_ICON_NAMES, type ProjectPreferences } from "../../../shared/project-preferences";
import { modelSelectionSchema } from "../../../shared/model-routing";
import type { IssueReportSettingsProps } from "./IssueReportSettings";
import { ProjectSearchDialog } from "./ProjectSearchDialog";
import { ProjectIcon } from "./ProjectIcon";
import { ProjectModelDefault } from "./ProjectModelDefault";
import { readProjectIcon } from "./project-settings-image";
import { Switch } from "./ui";
import "./ProjectSettings.css";

interface Props {
  initialProjectId?: string;
  projects: Project[];
  conversations: Conversation[];
  providers: ProviderInfo[];
  backendDefaults: ModelBackendDefault[];
  backendProfiles: ModelBackendProfileView[];
  settings: AppSettings;
  disabled: boolean;
  request?: IssueReportSettingsProps["request"];
  onUpdateSettings: (settings: Partial<AppSettings>) => void;
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }): React.JSX.Element {
  return <div className="project-setting-row"><div><h3>{title}</h3><p>{description}</p></div><div className="project-setting-control">{children}</div></div>;
}

const workspaceOptions = { local: "Current checkout", worktree: "Isolated worktree" };

function ProjectSelect({ label, value, disabled, options, onChange }: {
  label: string; value: string; disabled: boolean; options: Record<string, string>; onChange: (value: string) => void;
}): React.JSX.Element {
  return <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </select>;
}

function ProjectEditor({ project, conversations, providers, backendDefaults, backendProfiles, settings, disabled, request, onRemoved }: Omit<Props, "projects" | "initialProjectId" | "onUpdateSettings"> & { project: Project; onRemoved: () => void }): React.JSX.Element {
  const preferences = project.preferences ?? defaultProjectPreferences();
  const [budget, setBudget] = useState(String(preferences.claudeMaxBudgetUsd ?? ""));
  const budgetErrorId = useId();
  const budgetText = budget.trim();
  const amount = budgetText === "" ? null : /^\d+(?:\.\d{1,2})?$/u.test(budgetText) ? Number(budgetText) : Number.NaN;
  const validBudget = amount === null || isValidClaudeTurnBudgetUsd(amount);
  const budgetChanged = validBudget && amount !== preferences.claudeMaxBudgetUsd;
  const [name, setName] = useState(project.name);
  const trimmedName = name.trim();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [actionName, setActionName] = useState("");
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const blocked = disabled || saving || !request;
  const busyProject = conversations.some((conversation) => conversation.projectId === project.id
    && (conversation.status === "running" || conversation.status === "needs-input"));
  const mutate = async (command: CommandWithoutId | (() => Promise<CommandWithoutId>)): Promise<boolean> => {
    if (blocked || savingRef.current || !request) return false;
    savingRef.current = true; setSaving(true); setError(null);
    try {
      await request(typeof command === "function" ? await command() : command);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save project settings.");
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };
  const save = (patch: { name?: string; groupingMode?: Project["groupingMode"]; preferences?: ProjectPreferences }): Promise<boolean> => mutate({ type: "project.update", payload: { projectId: project.id, expectedUpdatedAt: project.updatedAt, ...patch } });
  const setModel = (selection: ModelSelection | null): void => {
    void mutate(selection
      ? { type: "backend.default.set", payload: { projectId: project.id, selection: modelSelectionSchema.parse(selection) } }
      : { type: "backend.default.clear", payload: { projectId: project.id } });
  };
  const setPreference = <K extends keyof ProjectPreferences>(key: K, value: ProjectPreferences[K]): void => {
    void save({ preferences: { ...preferences, [key]: value } });
  };
  return <>
    {error && <p className="project-settings-error" role="alert">{error}</p>}
    <section className="project-settings-card" aria-label="Project defaults">
      <Row title="Name" description="The name shown in the sidebar and thread lists.">
        <form className="project-name-form" onSubmit={(event) => { event.preventDefault(); if (trimmedName) void save({ name: trimmedName }); }}>
          <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={blocked} />
          {trimmedName !== project.name && <button type="submit" disabled={blocked || !trimmedName}>Save</button>}
        </form>
      </Row>
      <Row title="Project icon" description="Choose a symbol or a small image stored only on this device.">
        <div className="project-icon-controls"><ProjectIcon project={project} size={21} />
          <button type="button" disabled={blocked} aria-expanded={iconsOpen} onClick={() => setIconsOpen(!iconsOpen)}>Choose icon</button>
          <button type="button" disabled={blocked} onClick={() => fileInput.current?.click()}>Choose file</button>
          {preferences.icon && <button type="button" disabled={blocked} onClick={() => setPreference("icon", null)}>Reset</button>}
          <input ref={fileInput} type="file" hidden disabled={blocked} accept="image/png,image/jpeg,image/webp" onChange={(event) => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (file) void mutate(async () => ({ type: "project.update", payload: { projectId: project.id, expectedUpdatedAt: project.updatedAt,
              preferences: { ...preferences, icon: { kind: "image", data: await readProjectIcon(file) } } } }));
          }} />
        </div>
        {iconsOpen && <div className="project-icon-grid" role="group" aria-label="Project icons">{PROJECT_ICON_NAMES.map((icon) => <button type="button" key={icon} aria-label={`${icon} icon`} disabled={blocked}
          onClick={() => { setPreference("icon", { kind: "symbol", name: icon }); setIconsOpen(false); }}><ProjectIcon project={{ color: project.color, preferences: { ...preferences, icon: { kind: "symbol", name: icon } } }} size={19} /></button>)}</div>}
      </Row>
      <Row title="Model" description="New threads use this default. Existing threads keep their model and session.">
        <ProjectModelDefault projectId={project.id} providers={providers} backendDefaults={backendDefaults}
          backendProfiles={backendProfiles} settings={settings} disabled={blocked} onChange={setModel} />
      </Row>
      <Row title="Workspace" description="Choose where new threads work. Existing checkouts are never moved.">
        <ProjectSelect label="Project default workspace" value={preferences.workspace ?? ""} disabled={blocked}
          options={{ "": `Inherit (${workspaceOptions[settings.newThreadMode].toLowerCase()})`, ...workspaceOptions }}
          onChange={(value) => setPreference("workspace", value as ProjectPreferences["workspace"] || null)} />
      </Row>
      <Row title="Automatically pull" description="Keep the default branch current only when its checkout is idle, clean and has no local commits. Off by default.">
        <Switch label="Automatically pull" checked={preferences.autoPull} disabled={blocked || !project.repositoryRoot} onChange={(value) => setPreference("autoPull", value)} />
      </Row>
      <Row title="Agent browser access" description="Allow agents to use Inertia's preview browser. Turning this off blocks new browser tool calls, not external CLI tools.">
        <ProjectSelect label="Agent browser access" value={preferences.browserAccess === null ? "inherit" : String(preferences.browserAccess)} disabled={blocked}
          options={{ inherit: "Inherit (on)", true: "On", false: "Off" }}
          onChange={(value) => setPreference("browserAccess", value === "inherit" ? null : value === "true")} />
      </Row>
      <Row title="Claude spend limit per turn" description="Caps estimated API cost for Claude on Anthropic; subagents count toward it.">
        <form className="project-budget-form" onSubmit={(event) => { event.preventDefault(); if (budgetChanged) setPreference("claudeMaxBudgetUsd", amount); }}>
          <input aria-label="Claude spend limit per turn (USD)" inputMode="decimal" autoComplete="off" placeholder="No limit" value={budget} disabled={blocked}
            aria-invalid={!validBudget} aria-describedby={validBudget ? undefined : budgetErrorId} onChange={(event) => setBudget(event.target.value)} />
          {budgetChanged && <button type="submit" aria-label="Save spend limit" disabled={blocked}>Save</button>}
        </form>
        {!validBudget && <p id={budgetErrorId} className="project-setting-field-error">Use 0.01 to 10,000 with up to two decimals, or empty for no limit.</p>}
      </Row>
    </section>
    <h2 className="project-settings-group-title">Checkout</h2>
    <section className="project-settings-card" aria-label="Checkout settings">
      <Row title="Project grouping" description="How this checkout joins project groups in navigation.">
        <ProjectSelect label="Project grouping" value={project.groupingMode ?? ""} disabled={blocked}
          options={{ "": `Use global (${settings.projectGrouping})`, repository: "Group by repository", "repository-path": "Group by repository and folder", separate: "Keep separate" }}
          onChange={(value) => void save({ groupingMode: value as Project["groupingMode"] || null })} />
      </Row>
      <Row title="Actions" description="Named commands for this checkout. Run explicitly from the workspace; saving never executes them.">
        <button type="button" disabled={blocked || preferences.actions.length >= 20} aria-expanded={actionOpen} onClick={() => setActionOpen(!actionOpen)}><Plus size={14} />Add action</button>
      </Row>
      {actionOpen && <form className="project-action-form" onSubmit={(event) => {
        event.preventDefault();
        void save({ preferences: { ...preferences, actions: [...preferences.actions, { id: crypto.randomUUID(), name: actionName.trim(), executable: executable.trim(), args: args ? args.split("\n") : [] }] } }).then((saved) => { if (saved) { setActionOpen(false); setActionName(""); setExecutable(""); setArgs(""); } });
      }}>
        <label>Name<input required maxLength={80} value={actionName} onChange={(event) => setActionName(event.target.value)} disabled={blocked} /></label>
        <label>Executable<input required maxLength={4096} value={executable} onChange={(event) => setExecutable(event.target.value)} disabled={blocked} placeholder="npm" /></label>
        <label>Arguments (one per line)<textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} disabled={blocked} placeholder={"run\nbuild"} /></label>
        <p>Arguments are passed literally. No shell expansion, pipes or command substitution.</p>
        <div><button type="button" onClick={() => setActionOpen(false)}>Cancel</button><button type="submit" disabled={blocked || !actionName.trim() || !executable.trim()}>Save action</button></div>
      </form>}
      {preferences.actions.length === 0 ? <p className="project-actions-empty">No custom actions configured. Detected package scripts remain available in the workspace.</p>
        : <ul className="project-actions-list">{preferences.actions.map((action) => <li key={action.id}><div><strong>{action.name}</strong><code>{[action.executable, ...action.args].join(" ")}</code></div><button type="button" aria-label={`Remove ${action.name}`} disabled={blocked} onClick={() => setPreference("actions", preferences.actions.filter(({ id }) => id !== action.id))}><Trash2 size={14} /></button></li>)}</ul>}
    </section>
    <h2 className="project-settings-group-title">Danger zone</h2>
    <section className="project-settings-card"><Row title="Remove project" description="Remove this project and its threads from Inertia. Files on disk are not touched.">
      <button type="button" className="is-danger" disabled={blocked || busyProject} onClick={() => {
        if (!request || !window.confirm(`Remove “${project.name}” and its threads from Inertia? This cannot be undone. Files on disk will not be deleted.`)) return;
        void mutate({ type: "project.remove", payload: { projectId: project.id } }).then((removed) => { if (removed) onRemoved(); });
      }}><Trash2 size={14} />Remove project</button>
    </Row></section>
    <span className="visually-hidden" role="status">{saving ? "Saving project settings" : ""}</span>
  </>;
}

export function ProjectSettings(props: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(props.initialProjectId ?? null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooser = useRef<HTMLButtonElement>(null);
  const selected = props.projects.find(({ id }) => id === selectedId);
  return <div className="project-settings">
    <header className="project-settings-heading"><div><h1>Projects</h1><p>Defaults for your next thread. Your existing work stays unchanged.</p></div>
      <button ref={chooser} type="button" aria-label="Choose project" aria-haspopup="dialog" aria-expanded={chooserOpen} onClick={() => setChooserOpen(!chooserOpen)}><ProjectIcon project={selected} /><span>{selected?.name ?? "All projects"}</span><ChevronDown size={14} /></button>
    </header>
    {chooserOpen && <ProjectSearchDialog projects={props.projects} selectedId={selectedId} includeAll label="Choose project" trigger={chooser.current} onClose={() => setChooserOpen(false)} onSelect={setSelectedId} />}
    {selectedId && !selected && <p role="status">This project is no longer available. Choose another project.</p>}
    {!selected ? <section className="project-settings-card"><Row title="Workspace default" description="Projects inherit this setting unless they override it.">
      <ProjectSelect label="Default workspace for all projects" value={props.settings.newThreadMode} disabled={props.disabled} options={workspaceOptions}
        onChange={(value) => props.onUpdateSettings({ newThreadMode: value as AppSettings["newThreadMode"] })} />
    </Row><p className="project-actions-empty">Choose a project to configure its name, icon, model, source control and actions. Global model defaults are in Providers.</p></section>
      : <ProjectEditor key={selected.id} {...props} project={selected} onRemoved={() => setSelectedId(null)} />}
  </div>;
}
