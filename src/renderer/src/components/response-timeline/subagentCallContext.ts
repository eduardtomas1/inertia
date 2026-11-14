import { createContext } from "react";
import type { SubagentTrace } from "@shared/contracts";
import type { SubagentCallMemory } from "./subagentCallMemory";

export interface SubagentCallContextValue {
  autoCollapse: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
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
