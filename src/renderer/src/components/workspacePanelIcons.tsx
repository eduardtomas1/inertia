import {
  Bot,
  Paperclip,
  TerminalSquare,
  Files,
  Flag,
  Gauge,
  GitCompareArrows,
  GitPullRequest,
  Globe2,
  ListChecks,
} from "lucide-react";
import type { WorkspacePanelTab } from "./workspacePanelTypes";

export const surfaceIcons: Record<WorkspacePanelTab, React.JSX.Element> = {
  "pull-requests": <GitPullRequest size={14} aria-hidden="true" />,
  changes: <GitCompareArrows size={14} aria-hidden="true" />,
  files: <Files size={14} aria-hidden="true" />,
  preview: <Globe2 size={14} aria-hidden="true" />,
  terminal: <TerminalSquare size={14} aria-hidden="true" />,
  attachments: <Paperclip size={14} aria-hidden="true" />,
  agents: <Bot size={14} aria-hidden="true" />,
  usage: <Gauge size={14} aria-hidden="true" />,
  goal: <Flag size={14} aria-hidden="true" />,
  plan: <ListChecks size={14} aria-hidden="true" />,
};
