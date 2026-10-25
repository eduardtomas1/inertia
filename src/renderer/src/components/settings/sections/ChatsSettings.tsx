import type { AppSettings } from "@shared/contracts";
import { DEFAULT_COMPACT_ON_RETURN } from "@shared/compact-on-return";
import { SettingRadioGroup, SettingSwitch, type SettingOption } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";
import { NewChatDefaults, type NewChatDefaultsProps } from "./NewChatDefaults";
import { TerminalFontSize } from "./TerminalFontSize";

const USAGE_DISPLAY_MODES: readonly SettingOption<AppSettings["usageDisplayMode"]>[] = [
  { value: "expanded", label: "Expanded" },
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
];

const COMPACT_ON_RETURN_CHOICES: readonly SettingOption<AppSettings["compactOnReturn"]>[] = [
  { value: "offer", label: "Offer" },
  { value: "never", label: "Never" },
];

export function ChatsSettings(props: NewChatDefaultsProps): React.JSX.Element {
  const { settings, disabled, onUpdate } = props;
  return (
    <>
      <NewChatDefaults {...props} />

      <SettingsGroup title="Transcript" headingId="transcript-heading">
        <div className="settings-rows">
          <SettingSwitch id="thinking-summaries" title="Show reasoning summaries" checked={settings.showThinking} disabled={disabled} onChange={(showThinking) => onUpdate({ showThinking })} />
          <SettingSwitch id="collapse-work-log" title="Collapse completed work logs" checked={settings.autoCollapseWorkLog} disabled={disabled} onChange={(autoCollapseWorkLog) => onUpdate({ autoCollapseWorkLog })} />
          <SettingSwitch id="jump-to-answers" title="Scroll to the start of new answers" checked={settings.autoScrollToFinalAnswer} disabled={disabled} onChange={(autoScrollToFinalAnswer) => onUpdate({ autoScrollToFinalAnswer })} />
          <SettingSwitch id="message-timestamps" title="Message timestamps" checked={settings.showTimestamps} disabled={disabled} onChange={(showTimestamps) => onUpdate({ showTimestamps })} />
          <SettingSwitch id="changed-file-summaries" title="Show changed files after each turn" checked={settings.showChangedFileSummaries} disabled={disabled} onChange={(showChangedFileSummaries) => onUpdate({ showChangedFileSummaries })} />
          <SettingSwitch id="code-wrap" title="Wrap code by default" checked={settings.defaultCodeWrap} disabled={disabled} onChange={(defaultCodeWrap) => onUpdate({ defaultCodeWrap })} />
          <SettingSwitch id="auto-open-plan" title="Open plan automatically" checked={settings.autoOpenPlan} disabled={disabled} onChange={(autoOpenPlan) => onUpdate({ autoOpenPlan })} />
          <SettingSwitch id="confirm-destructive-actions" title="Confirm destructive actions" description="Ask before deleting chats or restoring checkpoints." checked={settings.confirmDestructiveActions} disabled={disabled} onChange={(confirmDestructiveActions) => onUpdate({ confirmDestructiveActions })} />
        </div>
        <SettingRadioGroup
          id="usage-display"
          title="Usage display"
          value={settings.usageDisplayMode}
          options={USAGE_DISPLAY_MODES}
          disabled={disabled}
          onChange={(usageDisplayMode) => onUpdate({ usageDisplayMode })}
        />
        <SettingRadioGroup
          id="compact-on-return"
          title="Compact large API chats when you return"
          description="Offers to summarize a chat of 200K tokens or more on an API key once its prompt cache has expired, so the next turn costs less."
          value={settings.compactOnReturn ?? DEFAULT_COMPACT_ON_RETURN}
          options={COMPACT_ON_RETURN_CHOICES}
          disabled={disabled}
          onChange={(compactOnReturn) => onUpdate({ compactOnReturn })}
        />
      </SettingsGroup>

      <SettingsGroup title="Review and terminal" headingId="source-heading">
        <div className="settings-rows">
          <SettingSwitch id="wrap-diffs" title="Wrap long diff lines" checked={settings.wrapDiffs} disabled={disabled} onChange={(wrapDiffs) => onUpdate({ wrapDiffs })} />
          <SettingSwitch id="ignore-whitespace" title="Ignore whitespace" checked={settings.ignoreWhitespace} disabled={disabled} onChange={(ignoreWhitespace) => onUpdate({ ignoreWhitespace })} />
        </div>
        <TerminalFontSize value={settings.terminalFontSize} disabled={disabled} onUpdate={onUpdate} />
      </SettingsGroup>
    </>
  );
}
