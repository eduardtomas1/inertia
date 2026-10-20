import { useId, useState } from "react";
import { FolderOpen } from "lucide-react";
import type {
  AccessMode,
  AppSettings,
  AppSnapshot,
  Initiative,
  InitiativePreferencesPatch,
  ModelSelection,
  Project,
} from "@shared/contracts";
import { ACCESS_MODE_LABELS, ACCESS_MODES, clampAccessMode, exceedsAccessCeiling } from "@shared/access-modes";
import { effectiveNewChatDefault } from "@shared/new-chat-default";
import { isValidClaudeTurnBudgetUsd } from "@shared/claude-turn-budget";

import { INTERFACE_LOCALE } from "../../lib/locale";
import { ModelDefaultSelect } from "../ProjectModelDefault";
import { SettingRow } from "../settings/SettingsLayout";
import { SettingTextField } from "../settings/SettingControls";
import { Switch } from "../ui";
import { InitiativeMcpServers } from "./InitiativeMcpServers";

export type InitiativeToolsSettings = Pick<
  AppSettings,
  "defaultProvider" | "defaultModel" | "defaultReasoningEffort" | "defaultAccessMode" | "providerIdentityLabels"
>;

const BUDGET_PATTERN = /^\d+(?:\.\d{1,2})?$/u;
const BUDGET_ERROR = "Use 0.01 to 10,000 with up to two decimals, or empty for no limit.";

/** Hints for values Settings also sets, and for those it does not have. */
const FROM_SETTINGS = { unset: "Inherited from Settings", eachChat: "Inherited from each chat's project or Settings" };
const BROWSER_DEFAULT = { unset: "Allowed by default", eachChat: "Inherited from each chat's project" };
const NO_SPEND_LIMIT = { unset: "No limit by default", eachChat: "Inherited from each chat's project" };

/**
 * Where an unset value comes from. With a default project the answer is
 * exact: the project, or what applies when no project sets it. Without one,
 * each chat's own project decides first.
 */
function inheritedHint(
  defaultProject: Project | null,
  projectSetsIt: boolean,
  otherwise: { unset: string; eachChat: string },
): string {
  if (!defaultProject) return otherwise.eachChat;
  return projectSetsIt ? "Inherited from project" : otherwise.unset;
}

function RowDescription({ text, hint }: { text: string; hint: string | null }): React.JSX.Element {
  return (
    <>
      {text}
      {hint && <span className="initiative-setting-source">{hint}</span>}
    </>
  );
}

function projectLabel(project: Project): string {
  return project.workspaceKind === "scratch" ? "No project" : project.name;
}

export interface InitiativeToolsProps {
  initiative: Initiative;
  snapshot: AppSnapshot;
  settings: InitiativeToolsSettings;
  offline: boolean;
  /** Resolves true when the runtime applied the change; failures are reported by the page. */
  onChange(patch: InitiativePreferencesPatch): Promise<boolean>;
  onOpenSkillsFolder(): Promise<void>;
}

/**
 * Shared tool settings for every chat in the initiative. Each value defers to
 * the chat's project and then to Settings until it is set here, and each
 * inherited row says where its value comes from.
 */
export function InitiativeTools({
  initiative,
  snapshot,
  settings,
  offline,
  onChange,
  onOpenSkillsFolder,
}: InitiativeToolsProps): React.JSX.Element {
  const headingId = useId();
  const [opening, setOpening] = useState(false);
  const preferences = initiative.preferences;
  const defaultProject = snapshot.projects.find(({ id }) => id === preferences.defaultProjectId) ?? null;
  const projectPreferences = defaultProject?.preferences;
  const send = (patch: InitiativePreferencesPatch): void => { void onChange(patch); };

  const inheritedModel = effectiveNewChatDefault(snapshot, settings, defaultProject?.id ?? null);
  const savedModel: ModelSelection | undefined = preferences.defaultModel
    ? { ...preferences.defaultModel, reasoningEffort: preferences.defaultReasoningEffort }
    : undefined;
  const ceiling = preferences.accessCeiling;
  // Chats start at most at the access limit, whichever layer sets the default.
  const inheritedAccess = clampAccessMode(projectPreferences?.defaultAccessMode ?? settings.defaultAccessMode, ceiling);
  const loweredAccess = preferences.defaultAccessMode && exceedsAccessCeiling(preferences.defaultAccessMode, ceiling)
    ? `Lowered to ${ACCESS_MODE_LABELS[clampAccessMode(preferences.defaultAccessMode, ceiling)]} by the access limit`
    : null;
  const projects = [...snapshot.projects].sort((left, right) =>
    Number(left.workspaceKind === "scratch") - Number(right.workspaceKind === "scratch")
    || left.name.localeCompare(right.name, INTERFACE_LOCALE));

  return (
    <section className="initiative-memory-section initiative-tools" aria-labelledby={headingId}>
      <header className="initiative-memory-heading">
        <h3 id={headingId}>Tools &amp; defaults</h3>
      </header>
      <p className="initiative-memory-hint">
        Every chat in this initiative uses these. Unset values come from the chat's project, then Settings.
      </p>
      <div className="initiative-tools-rows">
        <SettingRow
          id="initiative-model"
          title="Default model"
          description={<RowDescription
            text="For chats you start here."
            hint={savedModel ? null : inheritedHint(
              defaultProject,
              inheritedModel.source === "project-backend",
              FROM_SETTINGS,
            )}
          />}
        >
          <ModelDefaultSelect
            saved={savedModel}
            inherited={inheritedModel.selection}
            providers={snapshot.providers}
            backendProfiles={snapshot.backendProfiles ?? []}
            providerIdentityLabels={settings.providerIdentityLabels}
            modelLabel="Default model for this initiative"
            reasoningLabel="Default reasoning for this initiative"
            disabled={offline}
            onChange={(selection) => send({
              defaultModel: selection ? { ...selection, reasoningEffort: null } : null,
              defaultReasoningEffort: selection?.reasoningEffort ?? null,
            })}
          />
        </SettingRow>
        <SettingRow
          id="initiative-default-access"
          title="Default access"
          description={<RowDescription
            text="For chats you start here."
            hint={preferences.defaultAccessMode
              ? loweredAccess
              : inheritedHint(defaultProject, Boolean(projectPreferences?.defaultAccessMode), FROM_SETTINGS)}
          />}
        >
          <select
            className="setting-select"
            aria-label="Default access for this initiative"
            value={preferences.defaultAccessMode ?? ""}
            disabled={offline}
            onChange={(event) => send({ defaultAccessMode: (event.target.value || null) as AccessMode | null })}
          >
            <option value="">Default ({ACCESS_MODE_LABELS[inheritedAccess]})</option>
            {ACCESS_MODES.map((mode) => {
              const above = exceedsAccessCeiling(mode, ceiling);
              return (
                <option key={mode} value={mode} disabled={above && preferences.defaultAccessMode !== mode}>
                  {ACCESS_MODE_LABELS[mode]}{above ? " — above the limit" : ""}
                </option>
              );
            })}
          </select>
        </SettingRow>
        <SettingRow
          id="initiative-access-ceiling"
          title="Access limit"
          description="No chat here can use more access than this. Choosing a lower limit lowers chats above it now."
        >
          <select
            className="setting-select"
            aria-label="Access limit for chats in this initiative"
            value={ceiling ?? ""}
            disabled={offline}
            onChange={(event) => send({ accessCeiling: (event.target.value || null) as AccessMode | null })}
          >
            <option value="">No limit</option>
            {ACCESS_MODES.map((mode) => <option key={mode} value={mode}>{ACCESS_MODE_LABELS[mode]}</option>)}
          </select>
        </SettingRow>
        <SettingRow
          id="initiative-browser-access"
          title="Agent browser access"
          description={<RowDescription
            text="Block stops the agent browser tools in every chat here. Allow can't reopen them where a project blocks them."
            hint={preferences.browserAccess === null
              ? inheritedHint(defaultProject, projectPreferences?.browserAccess != null, BROWSER_DEFAULT)
              : null}
          />}
        >
          <select
            className="setting-select"
            aria-label="Agent browser access for this initiative"
            value={preferences.browserAccess === null ? "inherit" : preferences.browserAccess ? "allow" : "block"}
            disabled={offline}
            onChange={(event) => send({
              browserAccess: event.target.value === "inherit" ? null : event.target.value === "allow",
            })}
          >
            <option value="inherit">Inherit</option>
            <option value="allow">Allow</option>
            <option value="block">Block</option>
          </select>
        </SettingRow>
        <SettingTextField
          id="initiative-spend-limit"
          title="Claude spend limit per turn"
          label="Claude spend limit per turn for this initiative (USD)"
          description={<RowDescription
            text="Claude on Anthropic only. The lower of this and the chat's project limit applies."
            hint={preferences.claudeMaxBudgetUsd === null
              ? inheritedHint(defaultProject, projectPreferences?.claudeMaxBudgetUsd != null, NO_SPEND_LIMIT)
              : null}
          />}
          value={preferences.claudeMaxBudgetUsd === null ? "" : String(preferences.claudeMaxBudgetUsd)}
          placeholder="No limit"
          inputMode="decimal"
          autoComplete="off"
          disabled={offline}
          normalize={(draft) => {
            const text = draft.trim();
            return BUDGET_PATTERN.test(text) ? String(Number(text)) : text;
          }}
          validate={(text) => text === "" || (BUDGET_PATTERN.test(text) && isValidClaudeTurnBudgetUsd(Number(text))) ? null : BUDGET_ERROR}
          onSave={async (text) => {
            if (!await onChange({ claudeMaxBudgetUsd: text === "" ? null : Number(text) })) {
              throw new Error("The spend limit could not be saved.");
            }
          }}
        />
        <SettingRow
          id="initiative-default-project"
          title="Default project"
          description="Chosen for you when you start a chat in this initiative."
        >
          <select
            className="setting-select"
            aria-label="Default project for this initiative"
            value={defaultProject?.id ?? ""}
            disabled={offline}
            onChange={(event) => send({ defaultProjectId: event.target.value || null })}
          >
            <option value="">None</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
          </select>
        </SettingRow>
        <SettingRow
          id="initiative-skills-folder"
          title="Skills folder"
          description={preferences.skillsFolder
            ? "Managed by Inertia. Claude chats here can use the skills in it: one folder per skill, each with a SKILL.md."
            : "A folder of skills that Claude chats here can use, managed by Inertia."}
        >
          <div className="initiative-skills-controls">
            {preferences.skillsFolder && (
              <button
                type="button"
                className="secondary-button"
                disabled={offline || opening}
                onClick={() => {
                  setOpening(true);
                  void onOpenSkillsFolder().finally(() => setOpening(false));
                }}
              >
                <FolderOpen size={14} aria-hidden="true" />Open folder
              </button>
            )}
            <Switch
              label="Skills folder for this initiative"
              checked={preferences.skillsFolder}
              disabled={offline}
              onChange={(skillsFolder) => send({ skillsFolder })}
            />
          </div>
        </SettingRow>
      </div>
      <InitiativeMcpServers initiative={initiative} offline={offline} onChange={onChange} />
    </section>
  );
}
