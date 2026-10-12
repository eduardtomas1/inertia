import {
  FileDiff,
  Flag,
  Folder,
  Gauge,
  Globe,
  ListChecks,
  ListTree,
  Paperclip,
  Terminal,
} from "lucide-react";
import type { WorkspacePanelTab } from "./workspacePanelTypes";

export const surfaceIcons: Record<WorkspacePanelTab, React.JSX.Element> = {
  changes: <FileDiff size={14} aria-hidden="true" />,
  files: <Folder size={14} aria-hidden="true" />,
  preview: <Globe size={14} aria-hidden="true" />,
  terminal: <Terminal size={14} aria-hidden="true" />,
  attachments: <Paperclip size={14} aria-hidden="true" />,
  agents: <ListTree size={14} aria-hidden="true" />,
  usage: <Gauge size={14} aria-hidden="true" />,
  goal: <Flag size={14} aria-hidden="true" />,
  plan: <ListChecks size={14} aria-hidden="true" />,
};
