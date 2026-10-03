import { useEffect, useRef, useState } from "react";
import { Bell, FileCode2, PanelLeft, Sun, TerminalSquare } from "lucide-react";

import type { AppSettings } from "@shared/contracts";
import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { CompletionSoundSettings } from "../notifications/CompletionSoundSettings";
import { loadMascotSettings } from "../settingsSectionLoaders";
import { ThemeLibrary } from "../ThemeLibrary";
import { WorkingIndicatorSettings } from "../working-indicator/WorkingIndicatorSettings";
import { AppUpdateSettings, type AppUpdateSettingsProps } from "./AppUpdateSettings";
import { RestoreDefaults } from "./RestoreDefaults";
import { SettingRadioGroup, SettingSwitch, type SettingOption } from "./SettingControls";
import { SettingsGroup, SettingStatus } from "./SettingsLayout";
import { useSettingAction } from "./useSettingAction";

export interface GeneralSettingsProps extends AppUpdateSettingsProps {
  settings: AppSettings;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}

const INTERFACE_SCALES: readonly SettingOption<AppSettings["interfaceScale"]>[] = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
  { value: "large", label: "Large" },
];
const PROJECT_GROUPINGS: readonly SettingOption<AppSettings["projectGrouping"]>[] = [
  { value: "repository", label: "Repository" },
  { value: "repository-path", label: "Repo + folder" },
  { value: "separate", label: "Keep separate" },
];
const USAGE_DISPLAY_MODES: readonly SettingOption<AppSettings["usageDisplayMode"]>[] = [
  { value: "expanded", label: "Expanded" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
];
const RESPONSE_DENSITIES: readonly SettingOption<AppSettings["responseDensity"]>[] = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
];

function TerminalFontSize({
  value,
  disabled,
  onUpdate,
}: {
  value: number;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const committed = useRef<(next: number) => void>(() => undefined);
  committed.current = (next) => {
    setDraft(null);
    if (next === (pending ?? value)) return;
    setPending(next);
    void action.run(() => onUpdate({ terminalFontSize: next })).then((saved) => {
      if (!saved) setPending((current) => (current === next ? null : current));
    });
  };
  useEffect(() => {
    if (pending !== null && pending === value) setPending(null);
  }, [pending, value]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onChange = (): void => committed.current(Number(element.value));
    element.addEventListener("change", onChange);
    return () => element.removeEventListener("change", onChange);
  }, []);
  const shown = draft ?? pending ?? value;
  return (
    <div className="range-setting" data-setting-id="terminal-font-size">
      <span className="setting-title">
        <label htmlFor="terminal-font-size">Terminal font size</label>
        <SettingStatus notice={action.notice} />
      </span>
      <output htmlFor="terminal-font-size">{shown}px</output>
      <input
        ref={input}
        id="terminal-font-size"
        type="range"
        min="11"
        max="22"
        step="1"
        value={shown}
        disabled={disabled}
        onChange={(event) => {
          if (event.nativeEvent.type !== "change") setDraft(Number(event.currentTarget.value));
        }}
      />
      <div className="range-labels"><span>Compact</span><span>Comfortable</span></div>
    </div>
  );
}

export function GeneralSettings({
  settings,
  disabled,
  onUpdate,
  ...appUpdate
}: GeneralSettingsProps): React.JSX.Element {
  const MascotSettings = useLoadedSurface(loadMascotSettings, true);
  const appearanceAction = useSettingAction();
  const updateAppearance = (update: Partial<AppSettings>): void => {
    void appearanceAction.run(() => onUpdate(update));
  };
  return (
    <>
      <RestoreDefaults
        completionSound={settings.completionSound}
        confirmDestructiveActions={settings.confirmDestructiveActions}
        disabled={disabled}
        onUpdate={onUpdate}
      />

      <SettingsGroup title="Appearance" headingId="appearance-heading" description="Choose an appearance mode, then make the whole workbench feel like yours." icon={Sun} notice={appearanceAction.notice}>
        <ThemeLibrary settings={settings} disabled={disabled} onUpdate={updateAppearance} />
        <SettingRadioGroup
          id="interface-scale"
          className="interface-scale-setting"
          title="Interface scale"
          description="Scale navigation, messages, controls, files, and diffs live. Terminal text stays independent."
          value={settings.interfaceScale}
          options={INTERFACE_SCALES}
          disabled={disabled}
          onChange={(interfaceScale) => onUpdate({ interfaceScale })}
        />
        <WorkingIndicatorSettings settings={settings.workingIndicator} disabled={disabled} onUpdate={onUpdate} />
      </SettingsGroup>

      <SettingsGroup title="Workspace" headingId="workspace-heading" description="Choose which quiet details help you stay oriented." icon={PanelLeft}>
        <SettingRadioGroup
          id="project-grouping"
          className="project-grouping-setting"
          title="Logical project grouping"
          description="Use canonical Git identity and normalized paths, never display names."
          value={settings.projectGrouping}
          options={PROJECT_GROUPINGS}
          disabled={disabled}
          onChange={(projectGrouping) => onUpdate({ projectGrouping })}
        />
        <div className="settings-rows">
          <SettingSwitch id="compact-sidebar" title="Compact project navigation" description="Reduce spacing while keeping project names readable." checked={settings.compactSidebar} disabled={disabled} onChange={(compactSidebar) => onUpdate({ compactSidebar })} />
          <SettingSwitch id="message-timestamps" title="Message timestamps" description="Show a quiet time label alongside each message." checked={settings.showTimestamps} disabled={disabled} onChange={(showTimestamps) => onUpdate({ showTimestamps })} />
          <SettingSwitch id="thinking-summaries" title="Live thinking summaries" description="Show provider-supplied reasoning summaries as they arrive." checked={settings.showThinking} disabled={disabled} onChange={(showThinking) => onUpdate({ showThinking })} />
          <SettingSwitch id="auto-open-plan" title="Open plan automatically" description="Reveal the Plan panel when an agent publishes steps." checked={settings.autoOpenPlan} disabled={disabled} onChange={(autoOpenPlan) => onUpdate({ autoOpenPlan })} />
          {MascotSettings && <MascotSettings />}
          <SettingSwitch id="confirm-destructive-actions" title="Confirm destructive actions" description="Ask before deleting threads or restoring checkpoints." checked={settings.confirmDestructiveActions} disabled={disabled} onChange={(confirmDestructiveActions) => onUpdate({ confirmDestructiveActions })} />
        </div>
        <SettingRadioGroup
          id="usage-display"
          className="usage-display-setting"
          title="Usage and context"
          label="Usage and context display"
          description="Choose a full composer card, a restrained summary, or hide provider usage entirely."
          value={settings.usageDisplayMode}
          options={USAGE_DISPLAY_MODES}
          disabled={disabled}
          onChange={(usageDisplayMode) => onUpdate({ usageDisplayMode })}
        />
      </SettingsGroup>

      <SettingsGroup title="Notifications" headingId="notifications-heading" description="Decide how Inertia tells you a task has finished or needs you." icon={Bell}>
        <div className="settings-rows">
          <SettingSwitch id="desktop-notifications" title="Desktop notifications" description="Show privacy-safe completion and attention alerts without prompt or response text." checked={settings.desktopNotifications} disabled={disabled} onChange={(desktopNotifications) => onUpdate({ desktopNotifications })} />
          <CompletionSoundSettings settings={settings.completionSound} disabled={disabled} onUpdate={onUpdate} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Agent responses" headingId="responses-heading" description="Choose how final answers and the work behind them are presented." icon={FileCode2}>
        <SettingRadioGroup
          id="response-density"
          title="Response density"
          description="Adjust spacing and type size without changing terminal text."
          value={settings.responseDensity}
          options={RESPONSE_DENSITIES}
          disabled={disabled}
          onChange={(responseDensity) => onUpdate({ responseDensity })}
        />
        <div className="settings-rows">
          <SettingSwitch id="code-wrap" title="Wrap code by default" description="Start fenced code blocks wrapped; each block still has its own control." checked={settings.defaultCodeWrap} disabled={disabled} onChange={(defaultCodeWrap) => onUpdate({ defaultCodeWrap })} />
          <SettingSwitch id="collapse-work-log" title="Collapse completed work logs" description="Keep final answers visible while condensing successful tool activity." checked={settings.autoCollapseWorkLog} disabled={disabled} onChange={(autoCollapseWorkLog) => onUpdate({ autoCollapseWorkLog })} />
          <SettingSwitch id="changed-file-summaries" title="Changed-file summaries" description="Show the current workspace file summary below the latest settled turn." checked={settings.showChangedFileSummaries} disabled={disabled} onChange={(showChangedFileSummaries) => onUpdate({ showChangedFileSummaries })} />
          <SettingSwitch id="jump-to-answers" title="Jump to completed answers" description="Position the transcript at the beginning of each new final answer." checked={settings.autoScrollToFinalAnswer} disabled={disabled} onChange={(autoScrollToFinalAnswer) => onUpdate({ autoScrollToFinalAnswer })} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Terminal" headingId="terminal-heading" description="Keep command output comfortable to read." icon={TerminalSquare}>
        <TerminalFontSize value={settings.terminalFontSize} disabled={disabled} onUpdate={onUpdate} />
      </SettingsGroup>

      <AppUpdateSettings {...appUpdate} />
    </>
  );
}
