import {
  Files,
  Flag,
  Gauge,
  GitCompareArrows,
  Globe,
  ListChecks,
  ListTree,
  Paperclip,
  TerminalSquare,
} from "lucide-react";
import type { WorkspacePanelTab } from "./workspacePanelTypes";

export const surfaceIcons: Record<WorkspacePanelTab, React.JSX.Element> = {
  changes: <GitCompareArrows size={14} aria-hidden="true" />,
  files: <Files size={14} aria-hidden="true" />,
  preview: <Globe size={14} aria-hidden="true" />,
  terminal: <TerminalSquare size={14} aria-hidden="true" />,
  attachments: <Paperclip size={14} aria-hidden="true" />,
  agents: <ListTree size={14} aria-hidden="true" />,
  usage: <Gauge size={14} aria-hidden="true" />,
  goal: <Flag size={14} aria-hidden="true" />,
  plan: <ListChecks size={14} aria-hidden="true" />,
};
