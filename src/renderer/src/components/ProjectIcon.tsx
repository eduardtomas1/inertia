import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
import { Box, Code2, Database, FolderGit2, Globe, Layers3, Sparkles, Terminal } from "lucide-react";
import type { Project } from "@shared/contracts";
import { projectColorTints, useProjectColorRevision } from "../lib/projectColorTints";
import "./ProjectIcon.css";

const symbols = { folder: FolderGit2, code: Code2, database: Database, globe: Globe, terminal: Terminal, layers: Layers3, box: Box, sparkles: Sparkles };

export type ProjectMarkSource = Pick<Project, "preferences">;

export function projectTintStyle(project: ProjectMarkSource | null | undefined): CSSProperties | undefined {
  const tints = projectColorTints(project?.preferences?.color);
  return tints ? { "--project-tint-light": tints.light, "--project-tint-dark": tints.dark } as CSSProperties : undefined;
}

export function projectNameTinted(project: ProjectMarkSource | null | undefined): boolean {
  return project?.preferences?.colorEmphasis === "icon-and-name" && projectTintStyle(project) !== undefined;
}

export function ProjectIcon({ project, size = 15 }: { project?: ProjectMarkSource | null; size?: number }): React.JSX.Element {
  useProjectColorRevision();
  const icon = project?.preferences?.icon;
  const tint = projectTintStyle(project);
  if (icon?.kind === "image") {
    return <img src={icon.data} alt="" width={size} height={size} style={tint}
      className={clsx("project-custom-icon", tint && "has-project-tint")} data-project-tinted={tint ? "true" : undefined} />;
  }
  const Symbol = icon?.kind === "symbol" ? symbols[icon.name] : FolderGit2;
  return <Symbol size={size} style={tint} aria-hidden="true"
    className={clsx("project-icon-symbol", tint && "has-project-tint")} data-project-tinted={tint ? "true" : undefined} />;
}

export function ProjectName({ project, className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & {
  project?: ProjectMarkSource | null;
  children: ReactNode;
}): React.JSX.Element {
  useProjectColorRevision();
  const tinted = projectNameTinted(project);
  return <span {...rest} className={clsx(className, tinted && "project-name-tinted")}
    style={tinted ? projectTintStyle(project) : undefined} data-project-tinted={tinted ? "true" : undefined}>{children}</span>;
}
