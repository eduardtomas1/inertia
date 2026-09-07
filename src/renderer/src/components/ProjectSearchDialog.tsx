import { Check, Folder, Search, Settings, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import "./ProjectSearchDialog.css";

export function ProjectSearchDialog({ projects, selectedId, includeAll = false, label, trigger, onClose, onSelect, onManage }: {
  projects: readonly Project[];
  selectedId: string | null;
  includeAll?: boolean;
  label: string;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onManage?: (project: Project) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null | undefined>(selectedId);
  const input = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const id = useId();
  const needle = query.trim().toLocaleLowerCase();
  const items = [
    ...(includeAll ? [{ id: null, name: "All projects", path: "" }] : []),
    ...projects,
  ].filter((project) => `${project.name} ${project.path}`.toLocaleLowerCase().includes(needle));
  const active = activeId === undefined ? items[0] : items.find((project) => project.id === activeId)
    ?? items.find((project) => project.id === selectedId) ?? items[0];
  const activeIndex = items.indexOf(active!);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const popup = surface.current;
    const position = (): void => {
      if (!popup || !trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(bounds.width, 240), window.innerWidth - 16);
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upward = below < 220 && above > below;
      popup.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
      popup.style.top = upward ? "auto" : `${Math.max(8, bounds.bottom + 4)}px`;
      popup.style.bottom = upward ? `${window.innerHeight - bounds.top + 4}px` : "auto";
      popup.style.width = `${width}px`;
      popup.style.setProperty("--project-popup-height", `${Math.max(80, upward ? above : below)}px`);
    };
    position();
    popup?.showPopover?.();
    input.current?.focus();
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      if (restoreFocus.current && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);
  useLayoutEffect(() => {
    document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, id]);
  const choose = (projectId: string | null): void => {
    onClose();
    onSelect(projectId);
  };

  return createPortal(
    <div ref={surface} className="project-search-popover" popover="auto" role="presentation"
      onToggle={(event) => {
        if (event.newState !== "closed") return;
        restoreFocus.current = false;
        onClose();
      }}>
      <section className="command-palette project-search-dialog" role="dialog" aria-label={label}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}>
        <div className="palette-search">
          <Search size={17} aria-hidden="true" />
          <input ref={input} value={query} placeholder="Search projects…" aria-label="Search projects"
            role="combobox" aria-expanded="true" aria-controls={`${id}-results`}
            aria-activedescendant={active ? `${id}-${activeIndex}` : undefined} autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(undefined);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) { event.stopPropagation(); return; }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                setActiveId(items[index]?.id ?? null);
              }
              if (!query && (event.key === "Home" || event.key === "End")) {
                event.preventDefault();
                setActiveId((event.key === "Home" ? items[0] : items.at(-1))?.id ?? null);
              }
              if (event.key === "Enter" && active) { event.preventDefault(); choose(active.id); }
            }} />
          <IconButton label="Close project search" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="palette-results" id={`${id}-results`} role="listbox" aria-label="Projects">
          <div className="palette-group">
            <span>Projects</span>
            {items.map((project, index) => (
              <div className="project-search-row" key={project.id ?? "all"} role="presentation">
                <button type="button" id={`${id}-${index}`} role="option" aria-label={project.name}
                  aria-describedby={project.path ? `${id}-${index}-path` : undefined}
                  aria-selected={project.id === selectedId} className={index === activeIndex ? "is-active" : undefined}
                  onPointerMove={() => setActiveId(project.id)} onClick={() => choose(project.id)}>
                  <Folder size={15} aria-hidden="true" />
                  <span><strong>{project.name}</strong>{project.path && <small id={`${id}-${index}-path`}>{project.path}</small>}</span>
                  {project.id === selectedId && <Check size={13} aria-hidden="true" />}
                </button>
                {project.id && onManage && <IconButton label={`Project actions for ${project.name}`} onClick={() => {
                  const candidate = projects.find((item) => item.id === project.id);
                  if (!candidate) return;
                  restoreFocus.current = false;
                  onClose();
                  onManage(candidate);
                }}><Settings size={13} /></IconButton>}
              </div>
            ))}
          </div>
          {!items.length && <div className="palette-empty"><Search size={18} /><strong>No matching projects</strong><span>Try a project name or folder path.</span></div>}
        </div>
      </section>
    </div>, document.body,
  );
}
