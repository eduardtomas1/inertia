import { Check, ChevronDown, Folder } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";

import type { NewChatProjectPicker } from "./types";

const TYPEAHEAD_RESET_MS = 600;

export function ProjectPicker({
  picker,
}: {
  picker: NewChatProjectPicker;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    picker.projects.findIndex(({ id }) => id === picker.selectedProject.id),
  );
  const [activeProjectId, setActiveProjectId] = useState(
    picker.selectedProject.id,
  );
  const activeProjectIndex = picker.projects.findIndex(
    ({ id }) => id === activeProjectId,
  );
  const activeIndex = activeProjectIndex >= 0
    ? activeProjectIndex
    : selectedIndex;
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const listboxId = useId();

  const close = (): void => {
    setOpen(false);
    typeaheadRef.current = "";
    if (typeaheadTimerRef.current !== null) {
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = null;
    }
  };
  const show = (index = selectedIndex): void => {
    if (picker.disabled || picker.projects.length === 0) return;
    const project = picker.projects[index];
    if (!project) return;
    setActiveProjectId(project.id);
    setOpen(true);
  };
  const select = (index: number): void => {
    if (picker.disabled) return;
    const project = picker.projects[index];
    close();
    if (project && project.id !== picker.selectedProject.id) {
      picker.onChange(project);
    }
  };

  useEffect(() => {
    if (picker.disabled) close();
  }, [picker.disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) {
      window.clearTimeout(typeaheadTimerRef.current);
    }
  }, []);

  const move = (offset: number): void => {
    if (!open) {
      show(selectedIndex);
      return;
    }
    show((activeIndex + offset + picker.projects.length) % picker.projects.length);
  };
  const typeahead = (key: string): void => {
    const normalizedKey = key.toLocaleLowerCase();
    const previous = typeaheadRef.current;
    typeaheadRef.current = previous.length > 0
      && [...previous].every((character) => character === normalizedKey)
      ? normalizedKey
      : previous + normalizedKey;
    if (typeaheadTimerRef.current !== null) {
      window.clearTimeout(typeaheadTimerRef.current);
    }
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadRef.current = "";
      typeaheadTimerRef.current = null;
    }, TYPEAHEAD_RESET_MS);
    const query = typeaheadRef.current;
    const start = open ? activeIndex + 1 : selectedIndex + 1;
    for (let offset = 0; offset < picker.projects.length; offset += 1) {
      const index = (start + offset) % picker.projects.length;
      if (picker.projects[index]?.name.toLocaleLowerCase().startsWith(query)) {
        show(index);
        break;
      }
    }
  };

  return (
    <div
      className="composer-project-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <Folder
        className="composer-project-picker-mark"
        size={12}
        style={{ color: picker.selectedProject.color ?? "var(--accent)" }}
        aria-hidden="true"
      />
      <span className="composer-project-picker-label">Project</span>
      <button
        type="button"
        role="combobox"
        aria-label="Project"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open
          ? `${listboxId}-option-${activeIndex}`
          : undefined}
        className="composer-project-picker-trigger"
        disabled={picker.disabled}
        onClick={() => {
          if (open) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (picker.disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            show(event.key === "Home" ? 0 : picker.projects.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) select(activeIndex);
            else show();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
            typeahead(event.key);
          }
        }}
      >
        <span>{picker.selectedProject.name}</span>
      </button>
      <ChevronDown size={11} aria-hidden="true" />
      {open && (
        <div
          className="composer-project-listbox"
          id={listboxId}
          role="listbox"
          aria-label="Project"
        >
          {picker.projects.map((project, index) => {
            const selected = project.id === picker.selectedProject.id;
            return (
              <button
                type="button"
                ref={(node) => { optionRefs.current[index] = node; }}
                id={`${listboxId}-option-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                className={clsx(
                  "composer-project-option",
                  selected && "is-selected",
                  index === activeIndex && "is-active",
                )}
                key={project.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveProjectId(project.id)}
                onClick={() => select(index)}
              >
                <Folder
                  size={12}
                  style={{ color: project.color ?? "var(--accent)" }}
                  aria-hidden="true"
                />
                <span>{project.name}</span>
                {selected && <Check size={12} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
