import {
  defaultSettings,
  type AppSettings,
} from "../../shared/contracts";
import { settingsFromState } from "./codecs";
import type { PersistenceContext } from "./context";
import type { StateRow } from "./rows";
import { parseProviderIdentityLabels } from "../../shared/provider-identities";
import { parseAppKeybindings } from "../../shared/keybindings";

type SettingsPersistenceContext = Pick<PersistenceContext, "database">;

export class SettingsRepository {
  constructor(private readonly context: SettingsPersistenceContext) {}

  state(): StateRow {
    const state = this.context.database.prepare("SELECT * FROM app_state WHERE id = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Runtime state is unavailable.");
    return state;
  }

  update(update: Partial<AppSettings>): void {
    const current = settingsFromState(this.state());
    const next = { ...current, ...update };
    this.context.database.prepare(`
      UPDATE app_state SET
        theme = ?, compact_sidebar = ?, show_timestamps = ?, terminal_font_size = ?,
        default_provider = ?, default_model = ?, default_access_mode = ?,
        new_thread_mode = ?, wrap_diffs = ?, ignore_whitespace = ?, show_thinking = ?,
        show_usage = ?, usage_display_mode = ?, interface_scale = ?, response_density = ?,
        workspace_startup_surface = ?, default_code_wrap = ?,
        auto_collapse_work_log = ?, show_changed_file_summaries = ?,
        sidebar_mode = ?, project_grouping = ?, auto_open_plan = ?,
        confirm_destructive_actions = ?, desktop_notifications = ?,
        provider_identity_labels_json = ?,
        keybindings_json = ?,
        default_reasoning_effort = ?,
        default_interaction_mode = ?,
        codex_binary_path = ?
      WHERE id = 1
    `).run(
      next.theme,
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
    );
  }

  initialize(): void {
    this.context.database.prepare(`INSERT OR IGNORE INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, default_provider, default_model, default_access_mode, new_thread_mode, wrap_diffs, ignore_whitespace, usage_display_mode, active_project_id, active_conversation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(defaultSettings.theme, Number(defaultSettings.compactSidebar), Number(defaultSettings.showTimestamps), defaultSettings.terminalFontSize, defaultSettings.defaultProvider, defaultSettings.defaultModel, defaultSettings.defaultAccessMode, defaultSettings.newThreadMode, Number(defaultSettings.wrapDiffs), Number(defaultSettings.ignoreWhitespace), defaultSettings.usageDisplayMode);
  }
}
