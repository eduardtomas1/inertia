import { useRef, useState } from "react";
import { ChevronDown, Folders, Plus, Trash2 } from "lucide-react";
import type { AppSettings, Conversation, Project, ProviderInfo, ModelBackendDefault, ModelBackendProfileView, ModelSelection } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { defaultProjectPreferences, isValidClaudeTurnBudgetUsd, PROJECT_ICON_NAMES, type ProjectAppearancePatch, type ProjectPreferences } from "../../../shared/project-preferences";
import { modelSelectionSchema } from "../../../shared/model-routing";
import { PROJECT_REPOSITORY_DISPLAY_LIMITS, projectRepositoryDisplayLimit } from "../../../shared/project-repository-limit";
import type { IssueReportSettingsProps } from "./IssueReportSettings";
import { ProjectSearchDialog } from "./ProjectSearchDialog";
import { ProjectIcon, ProjectName } from "./ProjectIcon";
import { ProjectColorPicker, ProjectEmphasisPicker } from "./ProjectAppearanceControls";
import { ProjectModelDefault } from "./ProjectModelDefault";
import { readProjectIcon } from "./project-settings-image";
import { Switch } from "./ui";
import { SettingDisclosure, SettingRow, SettingsGroup } from "./settings/SettingsLayout";
import { SettingRadioGroup, SettingSwitch, SettingTextField } from "./settings/SettingControls";
import { useSettingAction } from "./settings/useSettingAction";
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
  onUpdateSettings: (settings: Partial<AppSettings>) => Promise<void>;
}

const workspaceOptions = { local: "Current checkout", worktree: "New worktree" };
const accessOptions: Record<AppSettings["defaultAccessMode"], string> = { supervised: "Supervised", "auto-edit": "Auto-accept edits", full: "Full access" };
const repositoryLimitOptions = Object.fromEntries(PROJECT_REPOSITORY_DISPLAY_LIMITS.map((limit) => [String(limit), `Show up to ${limit} repositories`]));
const groupingOptions: Record<AppSettings["projectGrouping"], string> = { repository: "By repository", "repository-path": "By repository and folder", separate: "Keep separate" };
const budgetPattern = /^\d+(?:\.\d{1,2})?$/u;
const budgetError = "Use 0.01 to 10,000 with up to two decimals, or empty for no limit.";

function saveFailure(failure: unknown): string {
  return failure instanceof Error && failure.message ? failure.message : "The project settings could not be saved. Try again.";
}

function normalizeBudget(draft: string): string {
  const text = draft.trim();
  return budgetPattern.test(text) ? String(Number(text)) : text;
}

function ProjectSelect({ label, value, disabled, options, onChange }: {
  label: string; value: string; disabled: boolean; options: Record<string, string>; onChange: (value: string) => void;
}): React.JSX.Element {
  return <select className="setting-select" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </select>;
}

function ProjectEditor({ project, conversations, providers, backendDefaults, backendProfiles, settings, disabled, request, onRemoved }: Omit<Props, "projects" | "initialProjectId" | "onUpdateSettings"> & { project: Project; onRemoved: () => void }): React.JSX.Element {
  const preferences = project.preferences ?? defaultProjectPreferences();
  const action = useSettingAction();
  const [noticeRow, setNoticeRow] = useState<string | null>(null);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [actionName, setActionName] = useState("");
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const blocked = disabled || saving || !request;
  const busyProject = conversations.some((conversation) => conversation.projectId === project.id
    && (conversation.status === "running" || conversation.status === "needs-input"));
  const send = async (command: CommandWithoutId | (() => Promise<CommandWithoutId>)): Promise<void> => {
    if (disabled || !request) throw new Error("The project settings are unavailable right now.");
    if (savingRef.current) throw new Error("Another project change is still saving. Try again.");
    savingRef.current = true; setSaving(true);
    try {
      await request(typeof command === "function" ? await command() : command);
    } finally { savingRef.current = false; setSaving(false); }
  };
  const change = (row: string, command: CommandWithoutId | (() => Promise<CommandWithoutId>)): Promise<boolean> => {
    if (blocked || savingRef.current) return Promise.resolve(false);
    setNoticeRow(row);
    return action.run(() => send(command), { failure: saveFailure });
  };
  const notice = (row: string) => noticeRow === row ? action.notice : null;
  const update = (patch: { name?: string; groupingMode?: Project["groupingMode"]; gitRepositoryLimit?: number; preferences?: ProjectPreferences }): CommandWithoutId => (
    { type: "project.update", payload: { projectId: project.id, expectedUpdatedAt: project.updatedAt, ...patch } });
  const setModel = (selection: ModelSelection | null): void => {
    void change("project-model", selection
      ? { type: "backend.default.set", payload: { projectId: project.id, selection: modelSelectionSchema.parse(selection) } }
      : { type: "backend.default.clear", payload: { projectId: project.id } });
  };
  const setPreference = <K extends keyof ProjectPreferences>(row: string, key: K, value: ProjectPreferences[K]): Promise<boolean> => (
    change(row, update({ preferences: { ...preferences, [key]: value } })));
  const setAppearance = (row: string, appearance: ProjectAppearancePatch): void => {
    void change(row, { type: "project.update", payload: { projectId: project.id, appearance } });
  };
  return <>
    <SettingsGroup title="General">
      <SettingTextField id="project-name" title="Name" label="Project name" value={project.name} maxLength={80}
        disabled={disabled || !request} failure={saveFailure}
        validate={(name) => name ? null : "Enter a project name."}
        onSave={(name) => send(update({ name }))} />
      <SettingRow id="project-icon" title="Icon" description="A symbol, or a small image stored only on this device." notice={notice("project-icon")}>
        <div className="project-setting-control">
          <div className="project-icon-controls"><ProjectIcon project={project} size={20} />
            <button type="button" className="secondary-button" disabled={blocked} aria-expanded={iconsOpen} onClick={() => setIconsOpen(!iconsOpen)}>Choose icon</button>
            <button type="button" className="secondary-button" disabled={blocked} onClick={() => fileInput.current?.click()}>Choose file</button>
            {preferences.icon && <button type="button" className="secondary-button" disabled={blocked} onClick={() => void setPreference("project-icon", "icon", null)}>Reset</button>}
            <input ref={fileInput} type="file" hidden disabled={blocked} accept="image/png,image/jpeg,image/webp" onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (file) void change("project-icon", async () => update({ preferences: { ...preferences, icon: { kind: "image", data: await readProjectIcon(file) } } }));
            }} />
          </div>
          {iconsOpen && <div className="project-icon-grid" role="group" aria-label="Project icons">{PROJECT_ICON_NAMES.map((icon) => <button type="button" key={icon} aria-label={`${icon} icon`} disabled={blocked}
            onClick={() => { void setPreference("project-icon", "icon", { kind: "symbol", name: icon }); setIconsOpen(false); }}><ProjectIcon project={{ preferences: { ...preferences, icon: { kind: "symbol", name: icon } } }} size={18} /></button>)}</div>}
        </div>
      </SettingRow>
      <SettingRow id="project-colour" title="Colour" description="Its chats inherit the colour." notice={notice("project-colour")}>
        <div className="project-setting-control">
          <ProjectColorPicker value={preferences.color} disabled={blocked} onChange={(color) => setAppearance("project-colour", { color })} />
        </div>
      </SettingRow>
      <SettingRow id="project-colour-emphasis" title="Colour shows on" notice={notice("project-colour-emphasis")}>
        <ProjectEmphasisPicker value={preferences.colorEmphasis} disabled={blocked} onChange={(colorEmphasis) => setAppearance("project-colour-emphasis", { colorEmphasis })} />
      </SettingRow>
      <SettingRow id="project-pin" title="Pin to top" description="First in the project filter and project choosers." notice={notice("project-pin")}>
        <Switch label="Pin to top of project lists" checked={preferences.pinned} disabled={blocked} onChange={(pinned) => setAppearance("project-pin", { pinned })} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="New chats">
      <SettingRow id="project-model" title="Model" description="Existing chats keep their model." notice={notice("project-model")}>
        <ProjectModelDefault projectId={project.id} providers={providers} backendDefaults={backendDefaults}
          backendProfiles={backendProfiles} settings={settings} disabled={blocked} onChange={setModel} />
      </SettingRow>
      <SettingRow id="project-workspace" title="Where new chats run" description="Existing checkouts are never moved." notice={notice("project-workspace")}>
        <ProjectSelect label="Where new chats run in this project" value={preferences.workspace ?? ""} disabled={blocked}
          options={{ "": `Default (${workspaceOptions[settings.newThreadMode]})`, ...workspaceOptions }}
          onChange={(value) => void setPreference("project-workspace", "workspace", value as ProjectPreferences["workspace"] || null)} />
      </SettingRow>
      <SettingRow id="project-default-access" title="Default access" description={preferences.defaultAccessMode === "full" ? "Choose Full access only for a workspace and task you trust." : undefined} notice={notice("project-default-access")}>
        <ProjectSelect label="Default access in this project" value={preferences.defaultAccessMode ?? ""} disabled={blocked}
          options={{ "": `Default (${accessOptions[settings.defaultAccessMode]})`, ...accessOptions }}
          onChange={(value) => void setPreference("project-default-access", "defaultAccessMode", value as ProjectPreferences["defaultAccessMode"] || null)} />
      </SettingRow>
      <SettingRow id="project-browser-access" title="Agent browser access" description="Turning this off blocks new preview browser tool calls, not external CLI tools." notice={notice("project-browser-access")}>
        <ProjectSelect label="Agent browser access" value={preferences.browserAccess === null ? "inherit" : String(preferences.browserAccess)} disabled={blocked}
          options={{ inherit: "Default (On)", true: "On", false: "Off" }}
          onChange={(value) => void setPreference("project-browser-access", "browserAccess", value === "inherit" ? null : value === "true")} />
      </SettingRow>
      <SettingTextField id="project-spend-limit" title="Claude spend limit per turn" label="Claude spend limit per turn (USD)"
        description="Caps estimated API cost for Claude on Anthropic; subagents count toward it."
        value={preferences.claudeMaxBudgetUsd === null ? "" : String(preferences.claudeMaxBudgetUsd)}
        placeholder="No limit" inputMode="decimal" autoComplete="off" disabled={disabled || !request} failure={saveFailure}
        normalize={normalizeBudget}
        validate={(text) => text === "" || (budgetPattern.test(text) && isValidClaudeTurnBudgetUsd(Number(text))) ? null : budgetError}
        onSave={(text) => send(update({ preferences: { ...preferences, claudeMaxBudgetUsd: text === "" ? null : Number(text) } }))} />
    </SettingsGroup>
    <SettingsGroup title="Checkout">
      <SettingRow id="project-grouping-override" title="Group this project" notice={notice("project-grouping-override")}>
        <ProjectSelect label="Group this project" value={project.groupingMode ?? ""} disabled={blocked}
          options={{ "": `Default (${groupingOptions[settings.projectGrouping]})`, ...groupingOptions }}
          onChange={(value) => void change("project-grouping-override", update({ groupingMode: value as Project["groupingMode"] || null }))} />
      </SettingRow>
      <SettingRow id="project-auto-pull" title="Automatically pull" description="Only while the default branch checkout is idle, clean and has no local commits." notice={notice("project-auto-pull")}>
        <Switch label="Automatically pull" checked={preferences.autoPull} disabled={blocked || !project.repositoryRoot} onChange={(value) => void setPreference("project-auto-pull", "autoPull", value)} />
      </SettingRow>
      <div className="project-actions-setting">
        <SettingRow id="project-actions" title="Actions" description="Named commands you run from the workspace. Saving never runs them." notice={notice("project-actions")}>
          <button type="button" className="secondary-button" disabled={blocked || preferences.actions.length >= 20} aria-expanded={actionOpen} onClick={() => setActionOpen(!actionOpen)}><Plus size={14} aria-hidden="true" />Add action</button>
        </SettingRow>
        {preferences.actions.length > 0 && <ul className="project-actions-list" aria-label="Project actions">{preferences.actions.map((projectAction) => <li key={projectAction.id}>
          <span><strong>{projectAction.name}</strong><code>{[projectAction.executable, ...projectAction.args].join(" ")}</code></span>
          <button type="button" className="icon-button" aria-label={`Remove ${projectAction.name}`} title={`Remove ${projectAction.name}`} disabled={blocked}
            onClick={() => void setPreference("project-actions", "actions", preferences.actions.filter(({ id }) => id !== projectAction.id))}><Trash2 size={14} aria-hidden="true" /></button>
        </li>)}</ul>}
        {actionOpen && <form className="project-action-form" aria-label="New action" onSubmit={(event) => {
          event.preventDefault();
          void change("project-actions", update({ preferences: { ...preferences, actions: [...preferences.actions, { id: crypto.randomUUID(), name: actionName.trim(), executable: executable.trim(), args: args ? args.split("\n") : [] }] } })).then((saved) => { if (saved) { setActionOpen(false); setActionName(""); setExecutable(""); setArgs(""); } });
        }}>
          <label>Name<input className="setting-input" required maxLength={80} value={actionName} onChange={(event) => setActionName(event.target.value)} disabled={blocked} /></label>
          <label>Executable<input className="setting-input" required maxLength={4096} value={executable} onChange={(event) => setExecutable(event.target.value)} disabled={blocked} placeholder="npm" /></label>
          <label className="project-action-arguments">Arguments (one per line)<textarea className="setting-input" rows={3} value={args} aria-describedby={`${project.id}-arguments-help`} onChange={(event) => setArgs(event.target.value)} disabled={blocked} placeholder={"run\nbuild"} />
            <small id={`${project.id}-arguments-help`}>Passed literally. No shell expansion, pipes or command substitution.</small></label>
          <div><button type="button" className="secondary-button" onClick={() => setActionOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={blocked || !actionName.trim() || !executable.trim()}>Save action</button></div>
        </form>}
      </div>
      <SettingDisclosure summary="Advanced" className="project-settings-advanced">
        <SettingRow id="project-repository-limit" title="Repository display limit" notice={notice("project-repository-limit")}>
          <ProjectSelect label="Repository display limit" value={String(projectRepositoryDisplayLimit(project.gitRepositoryLimit))} disabled={blocked}
            options={repositoryLimitOptions} onChange={(value) => void change("project-repository-limit", update({ gitRepositoryLimit: Number(value) }))} />
        </SettingRow>
      </SettingDisclosure>
    </SettingsGroup>
    <SettingsGroup title="Danger zone">
      <SettingRow id="project-remove" title="Remove project" description="Removes the project and its chats from Inertia. Files on disk are not touched." notice={notice("project-remove")}>
        <button type="button" className="secondary-button is-danger" disabled={blocked || busyProject} onClick={() => {
          if (!request || !window.confirm(`Remove “${project.name}” and its chats from Inertia? This cannot be undone. Files on disk will not be deleted.`)) return;
          void change("project-remove", { type: "project.remove", payload: { projectId: project.id } }).then((removed) => { if (removed) onRemoved(); });
        }}><Trash2 size={14} aria-hidden="true" />Remove project</button>
      </SettingRow>
    </SettingsGroup>
    <span className="visually-hidden" role="status">{saving ? "Saving project settings" : ""}</span>
  </>;
}

export function ProjectSettings(props: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(props.initialProjectId ?? null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const chooser = useRef<HTMLButtonElement>(null);
  const selected = props.projects.find(({ id }) => id === selectedId);
  return <div className="project-settings">
    <SettingRow id="project-chooser" title="Project" className="project-chooser-row"
      description={selectedId && !selected ? "This project is no longer available. Choose another project." : undefined}>
      <button ref={chooser} type="button" className="project-chooser" aria-label="Choose project" title={selected?.name}
        aria-haspopup="dialog" aria-expanded={chooserOpen} onClick={() => setChooserOpen(!chooserOpen)}>
        {selected ? <ProjectIcon project={selected} /> : <Folders size={15} aria-hidden="true" />}
        <ProjectName project={selected}>{selected?.name ?? "All projects"}</ProjectName>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </SettingRow>
    {chooserOpen && <ProjectSearchDialog projects={props.projects} selectedId={selectedId} includeAll label="Choose project" trigger={chooser.current} onClose={() => setChooserOpen(false)} onSelect={setSelectedId} />}
    {!selected ? <SettingsGroup title="All projects">
      <SettingRadioGroup id="project-grouping" title="Group projects" description="Uses Git identity and normalized paths, never display names."
        value={props.settings.projectGrouping} disabled={props.disabled}
        options={(Object.keys(groupingOptions) as AppSettings["projectGrouping"][]).map((value) => ({ value, label: groupingOptions[value] }))}
        onChange={(projectGrouping) => props.onUpdateSettings({ projectGrouping })} />
      <SettingSwitch id="compact-sidebar" title="Compact sidebar" description="Less spacing in project navigation." checked={props.settings.compactSidebar} disabled={props.disabled}
        onChange={(compactSidebar) => props.onUpdateSettings({ compactSidebar })} />
    </SettingsGroup>
      : <ProjectEditor key={selected.id} {...props} project={selected} onRemoved={() => setSelectedId(null)} />}
  </div>;
}
