import type { AppSettings } from "@shared/contracts";
import { SettingRadioGroup, SettingSwitch, type SettingOption } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";
import { NewChatDefaults, type NewChatDefaultsProps } from "./NewChatDefaults";
import { TerminalFontSize } from "./TerminalFontSize";

const USAGE_DISPLAY_MODES: readonly SettingOption<AppSettings["usageDisplayMode"]>[] = [
  { value: "expanded", label: "Expanded" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
];

export function ChatsSettings(props: NewChatDefaultsProps): React.JSX.Element {
  const { settings, disabled, onUpdate } = props;
  return (
    <>
      <NewChatDefaults {...props} />

      <SettingsGroup title="Transcript" headingId="transcript-heading">
        <div className="settings-rows">
          <SettingSwitch id="thinking-summaries" title="Show reasoning summaries" description="Provider-supplied summaries, shown as they arrive." checked={settings.showThinking} disabled={disabled} onChange={(showThinking) => onUpdate({ showThinking })} />
          <SettingSwitch id="collapse-work-log" title="Collapse completed work logs" description="Final answers stay visible; successful tool activity is condensed." checked={settings.autoCollapseWorkLog} disabled={disabled} onChange={(autoCollapseWorkLog) => onUpdate({ autoCollapseWorkLog })} />
          <SettingSwitch id="jump-to-answers" title="Scroll to the start of new answers" checked={settings.autoScrollToFinalAnswer} disabled={disabled} onChange={(autoScrollToFinalAnswer) => onUpdate({ autoScrollToFinalAnswer })} />
          <SettingSwitch id="message-timestamps" title="Message timestamps" checked={settings.showTimestamps} disabled={disabled} onChange={(showTimestamps) => onUpdate({ showTimestamps })} />
          <SettingSwitch id="changed-file-summaries" title="Show changed files after each turn" checked={settings.showChangedFileSummaries} disabled={disabled} onChange={(showChangedFileSummaries) => onUpdate({ showChangedFileSummaries })} />
          <SettingSwitch id="code-wrap" title="Wrap code by default" description="Each code block keeps its own wrap control." checked={settings.defaultCodeWrap} disabled={disabled} onChange={(defaultCodeWrap) => onUpdate({ defaultCodeWrap })} />
          <SettingSwitch id="auto-open-plan" title="Open plan automatically" description="Opens the Plan panel when an agent publishes steps." checked={settings.autoOpenPlan} disabled={disabled} onChange={(autoOpenPlan) => onUpdate({ autoOpenPlan })} />
          <SettingSwitch id="confirm-destructive-actions" title="Confirm destructive actions" description="Ask before deleting chats or restoring checkpoints." checked={settings.confirmDestructiveActions} disabled={disabled} onChange={(confirmDestructiveActions) => onUpdate({ confirmDestructiveActions })} />
        </div>
        <SettingRadioGroup
          id="usage-display"
          title="Usage display"
          description="Provider usage and context in the composer."
          value={settings.usageDisplayMode}
          options={USAGE_DISPLAY_MODES}
          disabled={disabled}
          onChange={(usageDisplayMode) => onUpdate({ usageDisplayMode })}
        />
      </SettingsGroup>

      <SettingsGroup title="Review and terminal" headingId="source-heading">
        <div className="settings-rows">
          <SettingSwitch id="wrap-diffs" title="Wrap long diff lines" checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} />
          <SettingSwitch id="ignore-whitespace" title="Ignore whitespace" description="Hide whitespace-only changes when supported." checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} />
        </div>
        <TerminalFontSize value={settings.terminalFontSize} disabled={disabled} onUpdate={onUpdate} />
      </SettingsGroup>
    </>
  );
}
