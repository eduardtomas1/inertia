import { Box, Code2, Database, FolderGit2, Globe, Layers3, Sparkles, Terminal } from "lucide-react";
import type { Project } from "@shared/contracts";
import "./ProjectIcon.css";

const symbols = { folder: FolderGit2, code: Code2, database: Database, globe: Globe, terminal: Terminal, layers: Layers3, box: Box, sparkles: Sparkles };

export function ProjectIcon({ project, size = 15 }: { project?: Pick<Project, "preferences" | "color">; size?: number }): React.JSX.Element {
  const icon = project?.preferences?.icon;
  if (icon?.kind === "image") return <img src={icon.data} alt="" width={size} height={size} className="project-custom-icon" />;
  const Symbol = icon?.kind === "symbol" ? symbols[icon.name] : FolderGit2;
  return <Symbol size={size} style={{ color: project?.color }} aria-hidden="true" />;
}
