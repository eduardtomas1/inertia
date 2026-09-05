import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Search,
  Settings,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "@shared/contracts";
import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { IconButton } from "../ui";

export function ProjectScopePicker({
  projects,
  selectedId,
  onSelect,
  onAdd,
  disabled,
  onManage,
}: {
  projects: readonly Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  disabled: boolean;
  onManage?: (project: Project, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"projects">();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = projects.find((project) => project.id === selectedId);
  const needle = query.trim().toLocaleLowerCase();
  const matches = projects.filter((project) =>
    `${project.name} ${project.path}`.toLocaleLowerCase().includes(needle),
  );
  const items = [
    ...(!needle ? [{ id: null, name: "All projects", path: "" }] : []),
    ...matches,
  ];
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  useNativePreviewSuspension(Boolean(menu));
  useLayoutEffect(() => {
    if (menu) {
      setQuery("");
      setActive(0);
      input.current?.focus();
    }
  }, [menu]);
  useLayoutEffect(() => {
    if (menu)
      document
        .getElementById(`${id}-${activeIndex}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, id, menu]);
  const choose = (projectId: string | null): void => {
    onSelect(projectId);
    dismissMenu("selection");
  };
  return (
    <div className="sidebar-project-scope">
      <button
        ref={(node) => {
          trigger.current = node;
          setMenuTrigger("projects", node);
        }}
        type="button"
        className="project-scope-trigger"
        aria-label="Filter work by project"
        aria-haspopup="dialog"
        aria-expanded={Boolean(menu)}
        aria-controls={menu ? id : undefined}
        onClick={() => toggleMenu("projects")}
      >
        <Folder size={16} />
        <span>{selected?.name ?? "All projects"}</span>
        <ChevronDown size={14} />
      </button>
      <IconButton label="Add project" disabled={disabled} onClick={onAdd}>
        <FolderPlus size={16} />
      </IconButton>
      {menu && (
        <div
          ref={(node) => setMenuPopover("projects", node)}
          className="project-scope-popover"
          role="dialog"
          aria-label="Choose project filter"
          id={id}
        >
          <div className="project-scope-search">
            <Search size={14} />
            <input
              ref={input}
              value={query}
              placeholder="Search projects…"
              aria-label="Search projects"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-results`}
              aria-activedescendant={
                items.length ? `${id}-${activeIndex}` : undefined
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(
                    (activeIndex +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      Math.max(1, items.length),
                  );
                }
                if (event.key === "Enter" && items[activeIndex]) {
                  event.preventDefault();
                  choose(items[activeIndex].id);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  dismissMenu("escape");
                }
              }}
            />
          </div>
          <div
            className="project-scope-results"
            role="listbox"
            aria-label="Projects"
            id={`${id}-results`}
          >
            {items.map((project, index) => (
              <div className="project-scope-item" key={project.id ?? "all"}>
                <button
                  type="button"
                  role="option"
                  aria-selected={project.id === (selected?.id ?? null)}
                  id={`${id}-${index}`}
                  className={
                    index === activeIndex ? "is-highlighted" : undefined
                  }
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(project.id)}
                >
                  <Folder size={15} />
                  <span>
                    <strong>{project.name}</strong>
                    {project.path && <small>{project.path}</small>}
                  </span>
                  {project.id === (selected?.id ?? null) && <Check size={13} />}
                </button>
                {project.id && onManage && (
                  <IconButton
                    label={`Project actions for ${project.name}`}
                    onClick={() => {
                      const selectedProject = projects.find(
                        (item) => item.id === project.id,
                      );
                      if (selectedProject && trigger.current) {
                        dismissMenu("context-change");
                        onManage(selectedProject, trigger.current);
                      }
                    }}
                  >
                    <Settings size={13} />
                  </IconButton>
                )}
              </div>
            ))}
            {!items.length && (
              <p className="project-scope-empty">No matching projects</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
