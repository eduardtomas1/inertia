import { Check, Folders, Palette, Pin, Search, Settings, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { trapModalFocus } from "../utils/modalFocus";
import { IconButton, LoadingMark } from "./ui";
import { ProjectIcon, ProjectName } from "./ProjectIcon";
import type { ProjectAppearanceUpdate } from "./ProjectCustomizePanel";
import { loadProjectCustomizePanel } from "./projectCustomizeLoader";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import "./ProjectSearchDialog.css";

function pinnedFirst<T extends { preferences?: Project["preferences"] }>(projects: readonly T[]): T[] {
  return [...projects.filter((project) => project.preferences?.pinned), ...projects.filter((project) => !project.preferences?.pinned)];
}

export function ProjectSearchDialog({ projects, selectedId, includeAll = false, label, trigger, onClose, onSelect, onManage, onCustomize, onOpenSettings }: {
  projects: readonly Project[];
  selectedId: string | null;
  includeAll?: boolean;
  label: string;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onManage?: (project: Project) => void;
  onCustomize?: ProjectAppearanceUpdate;
  onOpenSettings?: (project: Project) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [customizingId, setCustomizingId] = useState<string | null>(null);
  const returnFocusId = useRef<string | null>(null);
  const customizing = customizingId && onCustomize ? projects.find((project) => project.id === customizingId) : undefined;
  const ProjectCustomizePanel = useLoadedSurface(loadProjectCustomizePanel, Boolean(customizing && onCustomize));
  const [activeId, setActiveId] = useState<string | null | undefined>(selectedId);
  const input = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const id = useId();
  const needle = query.trim().toLocaleLowerCase();
  const items = [
    ...(includeAll ? [{ id: null, name: "All projects", path: "" }] : []),
    ...pinnedFirst(projects),
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
  useLayoutEffect(() => {
    if (customizingId && !customizing) {
      setCustomizingId(null);
      input.current?.focus({ preventScroll: true });
      return;
    }
    if (customizing || !returnFocusId.current) return;
    surface.current?.querySelector<HTMLElement>(`[data-customize-project-id="${returnFocusId.current}"]`)?.focus({ preventScroll: true });
    returnFocusId.current = null;
  }, [customizing, customizingId]);
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
      <section className="command-palette project-search-dialog" role="dialog"
        aria-label={customizing && onCustomize ? `Customise ${customizing.name}` : label}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}>
        {customizing && onCustomize ? ProjectCustomizePanel
          ? <ProjectCustomizePanel key={customizing.id} project={customizing} headingId={`${id}-customize`} onUpdate={onCustomize}
            onBack={() => { returnFocusId.current = customizing.id; setCustomizingId(null); }}
            onOpenSettings={onOpenSettings ? (project) => { restoreFocus.current = false; onClose(); onOpenSettings(project); } : undefined} />
          : <div className="project-customize-loading" tabIndex={-1} ref={(node) => node?.focus({ preventScroll: true })}><LoadingMark label="Loading project customisation" /></div>
        : <>
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
                <button type="button" id={`${id}-${index}`} role="option"
                  aria-label={"color" in project && project.preferences?.pinned ? `${project.name}, pinned` : project.name}
                  aria-describedby={project.path ? `${id}-${index}-path` : undefined}
                  aria-selected={project.id === selectedId} className={index === activeIndex ? "is-active" : undefined}
                  onPointerMove={() => setActiveId(project.id)} onClick={() => choose(project.id)}>
                  {"color" in project ? <ProjectIcon project={project} size={15} /> : <Folders size={15} aria-hidden="true" className="project-all-icon" />}
                  <span><strong><ProjectName project={"color" in project ? project : undefined}>{project.name}</ProjectName></strong>{project.path && <small id={`${id}-${index}-path`}>{project.path}</small>}</span>
                  {"color" in project && project.preferences?.pinned && <Pin size={11} aria-hidden="true" className="project-search-pin" />}
                  {project.id === selectedId && <Check size={13} aria-hidden="true" />}
                </button>
                {project.id && onCustomize && <IconButton label={`Customise ${project.name}`} data-customize-project-id={project.id}
                  onPointerEnter={() => void loadProjectCustomizePanel()} onFocus={() => void loadProjectCustomizePanel()}
                  onClick={() => setCustomizingId(project.id)}><Palette size={13} /></IconButton>}
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
        </>}
      </section>
    </div>, document.body,
  );
}
