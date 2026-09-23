import { ChevronDown, FolderPlus, Folders } from "lucide-react";
import { useRef, useState } from "react";
import type { Project } from "@shared/contracts";
import { ProjectIcon, ProjectName } from "../ProjectIcon";
import type { ProjectAppearanceUpdate } from "../ProjectCustomizePanel";
import { ProjectSearchDialog } from "../ProjectSearchDialog";
import { IconButton } from "../ui";

export function ProjectScopePicker({ projects, selectedId, onSelect, onAdd, disabled, onManage, onCustomize, onOpenSettings }: {
  projects: readonly Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  disabled: boolean;
  onManage?: (project: Project, trigger: HTMLButtonElement) => void;
  onCustomize?: ProjectAppearanceUpdate;
  onOpenSettings?: (project: Project) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = projects.find((project) => project.id === selectedId);
  return (
    <div className="sidebar-project-scope">
      <button ref={trigger} type="button" className="project-scope-trigger"
        aria-label="Filter work by project" aria-haspopup="dialog" aria-expanded={open}
        aria-description={selected ? `Showing ${selected.name}` : "Showing all projects"}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        }}>
        {selected ? <ProjectIcon project={selected} size={16} /> : <Folders size={16} aria-hidden="true" />}
        <ProjectName project={selected}>{selected?.name ?? "All projects"}</ProjectName>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <IconButton label="Add project" disabled={disabled} onClick={onAdd}><FolderPlus size={16} /></IconButton>
      {open && <ProjectSearchDialog projects={projects} selectedId={selected?.id ?? null} includeAll
        label="Choose project filter" trigger={trigger.current} onClose={() => setOpen(false)} onSelect={onSelect}
        onCustomize={onCustomize} onOpenSettings={onOpenSettings}
        onManage={onManage ? (project) => { if (trigger.current) onManage(project, trigger.current); } : undefined} />}
    </div>
  );
}
