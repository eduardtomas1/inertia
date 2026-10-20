import type {
  AppSnapshot,
  Conversation,
  Project,
  ProjectGroupingMode,
  WorkspaceRun,
} from "@shared/contracts";

import type { AppView } from "../../appView";
import type { ProjectAppearanceUpdate } from "../ProjectCustomizePanel";
import type { ConnectionStatus } from "../../hooks/useInertiaConnection";
import type { AppUpdateController } from "../../hooks/useAppUpdate";
import type { UpdateEverythingController } from "../../hooks/useUpdateEverything";

export interface SidebarProps {
  snapshot: AppSnapshot | null;
  connectionStatus: ConnectionStatus;
  view: AppView;
  open: boolean;
  busy: boolean;
  appUpdate?: AppUpdateController;
  updateEverything?: UpdateEverythingController;
  layoutWidth: number;
  onClose: () => void;
  onViewChange: (view: AppView) => void;
  onOpenHome: () => void;
  onImportProject: () => void;
  projectScopeId: string | null;
  onProjectScopeChange: (projectId: string | null) => void;
  onSelectConversation: (conversation: Conversation) => void;
  detachedConversationIds?: ReadonlySet<string>;
  detachedChatLimitReached?: boolean;
  splitConversationIds: ReadonlySet<string>;
  splitViewFull?: boolean;
  onOpenConversationInSplit: (conversation: Conversation) => void;
  onOpenConversationInWindow?: (conversation: Conversation) => void;
  onCloseConversationSplit: (conversation: Conversation) => void;
  onCreateConversation: (project: Project) => void;
  onChooseNewChatProject: () => void;
  onOpenMultiSpawn: () => void;
  onOpenDailyWork: () => void;
  newChatShortcut?: string;
  dailyWorkOpen: boolean;
  onRenameConversation: (conversation: Conversation, title: string) => void;
  onMarkConversationUnread?: (conversation: Conversation) => void;
  onRegenerateConversationTitle?: (conversation: Conversation) => void;
  onOpenProjectSettings?: (project: Project) => void;
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
  onUpdateProjectAppearance?: ProjectAppearanceUpdate;
  /** Opens the Initiative page with this initiative selected. */
  onOpenInitiative?: (initiativeId: string) => void;
  /** Moves a chat into an active initiative, or out of its initiative with null. */
  onAssignConversationInitiative?: (conversation: Conversation, initiativeId: string | null) => void;
  /** Asks for a name, creates an initiative and moves the chat into it. */
  onCreateInitiativeForConversation?: (conversation: Conversation) => void;
}
