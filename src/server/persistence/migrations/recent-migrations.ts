import type { DatabaseMigrationDefinition } from "./catalog";
import { cliConversationImportsMigration } from "./cli-conversation-imports";
import { agentThreadTargetOwnershipMigration } from "./agent-thread-target-ownership";
import { attachmentStorageSettingsMigration } from "./attachment-storage-settings";
import { completionSoundMigration } from "./completion-sound";
import { conversationContextDeliveriesMigration } from "./conversation-context-deliveries";
import { conversationContextWholeChatMigration } from "./conversation-context-whole-chat";
import { customAppearanceColorsMigration } from "./custom-appearance-colors";
import { nativeAntigravityProviderMigration } from "./native-antigravity-provider";
import { queuedMessagesMigration } from "./queued-messages";
import { turnSessionRecoveryMigration } from "./turn-session-recovery";
import { workingIndicatorMigration } from "./working-indicator";

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
  cliConversationImportsMigration,
];
