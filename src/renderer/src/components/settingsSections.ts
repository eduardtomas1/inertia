import {
  Activity,
  ArchiveRestore,
  Bot,
  FolderOpen,
  GitCompareArrows,
  Keyboard,
  Laptop,
  PanelLeft,
  Scan,
  ServerCog,
  type LucideIcon,
} from "lucide-react";

export type SettingsSection =
  | "support"
  | "general"
  | "snapshots"
  | "projects"
  | "providers"
  | "backends"
  | "connections"
  | "discord"
  | "diagnostics"
  | "source"
  | "keybindings"
  | "archive";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: PanelLeft },
  { id: "snapshots", label: "Snapshots", icon: Scan },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "backends", label: "Model backends", icon: ServerCog },
  { id: "connections", label: "Connections & devices", icon: Laptop },
  { id: "discord", label: "Discord", icon: Bot },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "source", label: "Source control", icon: GitCompareArrows },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "support", label: "Report an issue", icon: Bot },
  { id: "archive", label: "Archive & data", icon: ArchiveRestore },
];
