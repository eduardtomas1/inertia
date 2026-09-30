import {
  defaultSettings,
  type AppSettingsUpdate,
} from "../../shared/contracts";
import { settingsFromState } from "./codecs";
import type { PersistenceContext } from "./context";
import type { StateRow } from "./rows";
import { parseProviderIdentityLabels } from "../../shared/provider-identities";
import { parseAppKeybindings } from "../../shared/keybindings";
import { parseWorkingIndicatorSettings } from "../../shared/working-indicator";
import { COMPLETION_SOUND_JSON_MAX_LENGTH, parseCompletionSoundSettings } from "../../shared/completion-sound";

type SettingsPersistenceContext = Pick<PersistenceContext, "database">;

export class SettingsRepository {
  constructor(private readonly context: SettingsPersistenceContext) {}

  state(): StateRow {
    const state = this.context.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }

  update(update: AppSettingsUpdate): void {
    const state = this.state();
    const current = settingsFromState(state);
    const workingIndicator = parseWorkingIndicatorSettings({
      ...current.workingIndicator,
      ...update.workingIndicator,
    });
    const completionSound = parseCompletionSoundSettings({
      ...current.completionSound,
      ...update.completionSound,
    });
    const next = { ...current, ...update, workingIndicator, completionSound };
    const completionSoundJson = JSON.stringify(next.completionSound);
    // A legacy whole-family selection still updates both halves atomically.
    const lightColorTheme = update.lightColorTheme ?? update.colorTheme ?? current.lightColorTheme ?? current.colorTheme;
    const darkColorTheme = update.darkColorTheme ?? update.colorTheme ?? current.darkColorTheme ?? current.colorTheme;
    const lightCustomColor = update.lightCustomColor !== undefined ? update.lightCustomColor
      : update.lightColorTheme !== undefined || update.colorTheme !== undefined ? null : current.lightCustomColor;
    const darkCustomColor = update.darkCustomColor !== undefined ? update.darkCustomColor
      : update.darkColorTheme !== undefined || update.colorTheme !== undefined ? null : current.darkCustomColor;
    this.context.database.prepare(`
      UPDATE app_state SET
        theme = ?, color_theme = ?, light_color_theme = ?, dark_color_theme = ?, light_custom_color = ?, dark_custom_color = ?, compact_sidebar = ?, show_timestamps = ?, terminal_font_size = ?,
        default_provider = ?, default_model = ?, default_access_mode = ?,
        new_thread_mode = ?, wrap_diffs = ?, ignore_whitespace = ?, show_thinking = ?,
        show_usage = ?, usage_display_mode = ?, interface_scale = ?, response_density = ?,
        workspace_startup_surface = ?, default_code_wrap = ?,
        auto_collapse_work_log = ?, show_changed_file_summaries = ?,
        auto_scroll_to_final_answer = ?,
        sidebar_mode = ?, project_grouping = ?, auto_open_plan = ?,
        confirm_destructive_actions = ?, desktop_notifications = ?,
        provider_identity_labels_json = ?,
        keybindings_json = ?,
        default_reasoning_effort = ?,
        default_interaction_mode = ?,
        codex_binary_path = ?,
        discord_release_repository_url = ?,
        attachment_storage_gib = ?, auto_remove_old_attachments = ?,
        working_indicator_json = ?,
        completion_sound_json = ?
      WHERE id = 1
    `).run(
      next.theme,
      next.colorTheme,
      lightColorTheme,
      darkColorTheme,
      lightCustomColor ?? null,
      darkCustomColor ?? null,
      Number(next.compactSidebar),
      Number(next.showTimestamps),
      next.terminalFontSize,
      next.defaultProvider,
      next.defaultModel,
      next.defaultAccessMode,
      next.newThreadMode,
      Number(next.wrapDiffs),
      Number(next.ignoreWhitespace),
      Number(next.showThinking),
      Number(next.usageDisplayMode !== "hidden"),
      next.usageDisplayMode,
      next.interfaceScale,
      next.responseDensity,
      next.workspaceStartupSurface,
      Number(next.defaultCodeWrap),
      Number(next.autoCollapseWorkLog),
      Number(next.showChangedFileSummaries),
      Number(next.autoScrollToFinalAnswer),
      next.sidebarMode,
      next.projectGrouping,
      Number(next.autoOpenPlan),
      Number(next.confirmDestructiveActions),
      Number(next.desktopNotifications),
      JSON.stringify(parseProviderIdentityLabels(next.providerIdentityLabels)),
      JSON.stringify(parseAppKeybindings(next.keybindings)),
      next.defaultReasoningEffort,
      next.defaultInteractionMode,
      next.codexBinaryPath,
      next.discordReleaseRepositoryUrl,
      next.attachmentStorageGiB, Number(next.autoRemoveOldAttachments),
      JSON.stringify(next.workingIndicator),
      completionSoundJson.length <= COMPLETION_SOUND_JSON_MAX_LENGTH
        ? completionSoundJson
        : state.completion_sound_json ?? "{}",
    );
  }

  initialize(): void {
    this.context.database.prepare(`INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(defaultSettings.theme, Number(defaultSettings.compactSidebar), Number(defaultSettings.showTimestamps), defaultSettings.terminalFontSize, defaultSettings.defaultProvider, defaultSettings.defaultModel, defaultSettings.defaultAccessMode, defaultSettings.newThreadMode, Number(defaultSettings.wrapDiffs), Number(defaultSettings.ignoreWhitespace), defaultSettings.usageDisplayMode);
  }
}
