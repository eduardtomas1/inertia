import type { AppSettings } from "@shared/contracts";
import {
  CLAUDE_AUTO_COMPACT_WINDOWS,
  CODEX_AUTO_COMPACT_LIMITS,
  DEFAULT_COMPACT_ON_RETURN,
} from "@shared/compact-on-return";
import { SettingRadioGroup, SettingSelect, SettingSwitch, type SettingOption } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";
import { NewChatDefaults, type NewChatDefaultsProps } from "./NewChatDefaults";
import { TerminalFontSize } from "./TerminalFontSize";

const USAGE_DISPLAY_MODES: readonly SettingOption<AppSettings["usageDisplayMode"]>[] = [
  { value: "compact", label: "Compact" },
  { value: "hidden", label: "Hidden" },
];

type CompactLargeChats = "on-return" | "before-expiry" | "never";

const COMPACT_LARGE_CHATS_CHOICES: readonly SettingOption<CompactLargeChats>[] = [
  { value: "on-return", label: "When you return" },
  { value: "before-expiry", label: "Before the cache expires" },
  { value: "never", label: "Never" },
];

const CLAUDE_DEFAULT_WINDOW = "claude-code-default";
const CODEX_DEFAULT_LIMIT = "codex-default";

const tokenChoices = (sizes: readonly number[], defaultValue: string, defaultLabel: string): readonly SettingOption<string>[] => [
  ...sizes.map((tokens) => ({ value: String(tokens), label: `${tokens / 1000}K tokens` })),
  { value: defaultValue, label: defaultLabel },
];

const AUTO_COMPACT_WINDOW_CHOICES = tokenChoices(CLAUDE_AUTO_COMPACT_WINDOWS, CLAUDE_DEFAULT_WINDOW, "Claude Code default");
const CODEX_AUTO_COMPACT_CHOICES = tokenChoices(CODEX_AUTO_COMPACT_LIMITS, CODEX_DEFAULT_LIMIT, "Codex default");

function compactLargeChats(settings: Pick<AppSettings, "compactOnReturn" | "compactBeforeCacheExpires">): CompactLargeChats {
  if ((settings.compactOnReturn ?? DEFAULT_COMPACT_ON_RETURN) === "never") return "never";
  return settings.compactBeforeCacheExpires ? "before-expiry" : "on-return";
}

function compactLargeChatsUpdate(choice: CompactLargeChats): Pick<AppSettings, "compactOnReturn" | "compactBeforeCacheExpires"> {
  return {
    compactOnReturn: choice === "never" ? "never" : "offer",
    compactBeforeCacheExpires: choice === "before-expiry",
  };
}

function tokenChoiceValue(tokens: number | null, choices: readonly SettingOption<string>[], defaultValue: string): string {
  if (tokens === null) return defaultValue;
  return choices.some(({ value }) => value === String(tokens)) ? String(tokens) : defaultValue;
}

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
          value={settings.usageDisplayMode === "expanded" ? "compact" : settings.usageDisplayMode}
          options={USAGE_DISPLAY_MODES}
          disabled={disabled}
          onChange={(usageDisplayMode) => onUpdate({ usageDisplayMode })}
        />
      </SettingsGroup>

      <SettingsGroup title="Context" headingId="context-heading">
        <SettingRadioGroup
          id="compact-on-return"
          title="Compact large chats"
          description="Once a chat of 200K tokens or more outlives its prompt cache, Send becomes Compact and send. Before the cache expires (beta) compacts idle Claude chats two minutes before their one-hour cache runs out."
          value={compactLargeChats(settings)}
          options={COMPACT_LARGE_CHATS_CHOICES}
          disabled={disabled}
          onChange={(choice) => onUpdate(compactLargeChatsUpdate(choice))}
        />
        <SettingSelect
          id="claude-auto-compact"
          title="Auto-compact Claude chats after"
          description="Claude Code summarizes a chat on its own just before this size. Its default waits until about 967K tokens on 1M-token models."
          value={tokenChoiceValue(settings.claudeAutoCompactWindow, AUTO_COMPACT_WINDOW_CHOICES, CLAUDE_DEFAULT_WINDOW)}
          options={AUTO_COMPACT_WINDOW_CHOICES}
          disabled={disabled}
          onChange={(value) => onUpdate({ claudeAutoCompactWindow: value === CLAUDE_DEFAULT_WINDOW ? null : Number(value) })}
        />
        <SettingSelect
          id="codex-auto-compact"
          title="Auto-compact Codex chats after"
          description="Codex summarizes a chat on its own at this size, or at 90% of the model's context if that is smaller. Its default waits until about 95% of the context."
          value={tokenChoiceValue(settings.codexAutoCompactTokenLimit, CODEX_AUTO_COMPACT_CHOICES, CODEX_DEFAULT_LIMIT)}
          options={CODEX_AUTO_COMPACT_CHOICES}
          disabled={disabled}
          onChange={(value) => onUpdate({ codexAutoCompactTokenLimit: value === CODEX_DEFAULT_LIMIT ? null : Number(value) })}
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
