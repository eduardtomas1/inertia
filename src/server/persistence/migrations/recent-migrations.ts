import { limitResetMigration } from "./limit-reset";
import type { DatabaseMigrationDefinition } from "./catalog";
import { cliConversationImportsMigration } from "./cli-conversation-imports";
import { agentThreadTargetOwnershipMigration } from "./agent-thread-target-ownership";
import { attachmentStorageSettingsMigration } from "./attachment-storage-settings";
import { completionSoundMigration } from "./completion-sound";
import { conversationContextDeliveriesMigration } from "./conversation-context-deliveries";
import { conversationContextWholeChatMigration } from "./conversation-context-whole-chat";
import { customAppearanceColorsMigration } from "./custom-appearance-colors";
import { mutedCustomColorsMigration } from "./muted-custom-colors";
import { nativeAntigravityProviderMigration } from "./native-antigravity-provider";
import { notificationPreferencesMigration } from "./notification-preferences";
import { queuedMessagesMigration } from "./queued-messages";
import { subagentTaskTelemetryMigration } from "./subagent-task-telemetry";
import { turnSessionRecoveryMigration } from "./turn-session-recovery";
import { workingIndicatorMigration } from "./working-indicator";
import { scratchProjectMigration } from "./scratch-project";
import { issueReportPreviewMigration } from "./issue-report-preview";
import { htmlRendersMigration } from "./html-renders";
import { agentContextReadsMigration } from "./agent-context-reads";

export const recentMigrationDefinitions: readonly DatabaseMigrationDefinition[] = [
  nativeAntigravityProviderMigration,
  conversationContextWholeChatMigration,
  workingIndicatorMigration,
  conversationContextDeliveriesMigration,
  attachmentStorageSettingsMigration,
  queuedMessagesMigration,
  agentThreadTargetOwnershipMigration,
  completionSoundMigration,
  turnSessionRecoveryMigration,
  customAppearanceColorsMigration,
  scratchProjectMigration,
  limitResetMigration,
  notificationPreferencesMigration,
  issueReportPreviewMigration,
  subagentTaskTelemetryMigration,
  mutedCustomColorsMigration,
  cliConversationImportsMigration,
  htmlRendersMigration,
  agentContextReadsMigration,
];
