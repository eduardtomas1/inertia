import type {
  AppSnapshot,
  Conversation,
  Project,
  ProjectGroupingMode,
  WorkspaceRun,
} from "@shared/contracts";

import type { AppView } from "../../appView";
import type { ConnectionStatus } from "../../hooks/useInertiaConnection";

export interface SidebarProps {
  snapshot: AppSnapshot | null;
  connectionStatus: ConnectionStatus;
  view: AppView;
  open: boolean;
  busy: boolean;
  updateAvailable?: boolean;
  layoutWidth: number;
  onClose: () => void;
  onViewChange: (view: AppView) => void;
  onOpenHome: () => void;
  onImportProject: () => void;
  onSelectConversation: (conversation: Conversation) => void;
  detachedConversationIds?: ReadonlySet<string>;
  detachedChatLimitReached?: boolean;
  splitConversationId: string | null;
  onOpenConversationInSplit: (conversation: Conversation) => void;
  onOpenConversationInWindow?: (conversation: Conversation) => void;
  onCloseConversationSplit: () => void;
  onCreateConversation: (project: Project) => void;
  onOpenMultiSpawn: () => void;
  onOpenDailyWork: () => void;
  dailyWorkOpen: boolean;
  onRenameConversation: (conversation: Conversation, title: string) => void;
  onPinConversation: (conversation: Conversation, pinned: boolean) => void;
  onSnoozeConversation: (conversation: Conversation, until: string | null) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onSettleConversation: (conversation: Conversation) => void;
  onRestoreConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onAcknowledgeRun: (run: WorkspaceRun) => void;
  onDismissRun: (run: WorkspaceRun) => void;
  onOpenProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
  onSetProjectGrouping: (
    project: Project,
    groupingMode: ProjectGroupingMode | null,
  ) => void;
  onSetProjectGitRepositoryLimit: (project: Project, limit: number) => void;
  onRemoveProject: (project: Project) => void;
}
