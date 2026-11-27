import { createContext } from "react";
import type { SubagentTrace } from "@shared/contracts";
import type { WorkspaceMediaPreviewTarget } from "@shared/workspace-media-preview";
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import type { WorkspacePanelTab } from "../workspacePanelTypes";
import type { SubagentCallMemory } from "./subagentCallMemory";

export interface SubagentCallContextValue {
  autoCollapse: boolean;
  projectRoot: string;
  projectBaseRoot?: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
  /** Opens Background tasks from a subagent group's agent rows. */
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
  memory?: SubagentCallMemory;
}

const ignoreProjectFile = (): void => undefined;

export const SubagentCallContext = createContext<SubagentCallContextValue>({
  autoCollapse: true,
  projectRoot: "",
  projectId: "",
  conversationId: "",
  defaultCodeWrap: false,
  onOpenProjectFile: ignoreProjectFile,
});
