import { ChevronDown, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProjectSearchDialog } from "../ProjectSearchDialog";
import type { NewChatProjectPicker } from "./types";

export function ProjectPicker({ picker }: { picker: NewChatProjectPicker }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (picker.disabled) setOpen(false); }, [picker.disabled]);
  return (
    <div className="composer-project-picker">
      <button ref={trigger} type="button" aria-label="Project" aria-haspopup="dialog" aria-expanded={open && !picker.disabled}
        className="composer-project-picker-trigger" disabled={picker.disabled || !picker.projects.length}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        }}>
        <Folder size={13} aria-hidden="true" /><span>{picker.selectedProject.name}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && !picker.disabled && <ProjectSearchDialog projects={picker.projects} selectedId={picker.selectedProject.id}
        label="Choose project" trigger={trigger.current} onClose={() => setOpen(false)} onSelect={(id) => {
          const project = picker.projects.find((candidate) => candidate.id === id);
          if (project && project.id !== picker.selectedProject.id) picker.onChange(project);
        }} />}
    </div>
  );
}
