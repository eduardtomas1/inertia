import { ChevronDown, Folder, FolderPlus } from "lucide-react";
import { useRef, useState } from "react";
import type { Project } from "@shared/contracts";
import { ProjectSearchDialog } from "../ProjectSearchDialog";
import { IconButton } from "../ui";

export function ProjectScopePicker({ projects, selectedId, onSelect, onAdd, disabled, onManage }: {
  projects: readonly Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  disabled: boolean;
  onManage?: (project: Project, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = projects.find((project) => project.id === selectedId);
  return (
    <div className="sidebar-project-scope">
      <button ref={trigger} type="button" className="project-scope-trigger"
        aria-label="Filter work by project" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}>
        <Folder size={16} /><span>{selected?.name ?? "All projects"}</span><ChevronDown size={14} />
      </button>
      <IconButton label="Add project" disabled={disabled} onClick={onAdd}><FolderPlus size={16} /></IconButton>
      {open && <ProjectSearchDialog projects={projects} selectedId={selected?.id ?? null} includeAll
        label="Choose project filter" trigger={trigger.current} onClose={() => setOpen(false)} onSelect={onSelect}
        onManage={onManage ? (project) => { if (trigger.current) onManage(project, trigger.current); } : undefined} />}
    </div>
  );
}
