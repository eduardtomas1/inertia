import { createContext } from "react";
import type { SubagentTrace } from "@shared/contracts";

export interface SubagentCallContextValue {
  autoCollapse: boolean;
  projectRoot: string;
  projectId: string;
  conversationId: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile: (path: string) => void;
  onStopSubagent?: (trace: SubagentTrace) => Promise<void>;
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
