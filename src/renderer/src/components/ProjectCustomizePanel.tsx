import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ImagePlus, Settings } from "lucide-react";
import type { Project } from "@shared/contracts";
import { defaultProjectPreferences, type ProjectAppearancePatch, type ProjectPreferences } from "@shared/project-preferences";
import { ProjectColorPicker, ProjectEmphasisPicker, ProjectIconPicker } from "./ProjectAppearanceControls";
import { ProjectIcon, ProjectName } from "./ProjectIcon";
import { readProjectIcon } from "./project-settings-image";
import { Switch } from "./ui";
import "./ProjectCustomizePanel.css";

export type ProjectAppearanceUpdate = (project: Project, appearance: ProjectAppearancePatch) => Promise<void> | void;

function settled(pending: ProjectAppearancePatch, preferences: ProjectPreferences): ProjectAppearancePatch {
  const remaining = Object.entries(pending).filter(([key, value]) => (
    JSON.stringify(preferences[key as keyof ProjectAppearancePatch]) !== JSON.stringify(value)
  ));
  return remaining.length === Object.keys(pending).length ? pending : Object.fromEntries(remaining);
}

export function ProjectCustomizePanel({ project, headingId, onBack, onUpdate, onOpenSettings }: {
  project: Project;
  headingId: string;
  onBack: () => void;
  onUpdate: ProjectAppearanceUpdate;
  onOpenSettings?: (project: Project) => void;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const latest = useRef(new Map<string, number>());
  const saved = useMemo(() => project.preferences ?? defaultProjectPreferences(), [project.preferences]);
  const [pending, setPending] = useState<ProjectAppearancePatch>({});
  const [error, setError] = useState<string | null>(null);
  const preferences: ProjectPreferences = { ...saved, ...pending };
  const preview: Project = { ...project, preferences };
  useEffect(() => { setPending((current) => settled(current, saved)); }, [saved]);
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Project colour"] [aria-checked="true"]')?.focus({ preventScroll: true });
  }, []);
  const apply = (appearance: ProjectAppearancePatch): void => {
    sequence.current += 1;
    const request = sequence.current;
    for (const key of Object.keys(appearance)) latest.current.set(key, request);
    setError(null);
    setPending((current) => ({ ...current, ...appearance }));
    void Promise.resolve(onUpdate(project, appearance)).catch((failure: unknown) => {
      const superseded = Object.keys(appearance).filter((key) => latest.current.get(key) !== request);
      setPending((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in appearance) || superseded.includes(key))));
      setError(failure instanceof Error ? failure.message : "Could not save the project appearance.");
    });
  };
  return <div ref={root} className="project-customize-panel"
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }}>
    <header className="project-customize-header">
      <button type="button" className="project-customize-back" aria-label="Back to projects" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /></button>
      <h2 id={headingId} className="project-customize-title">
        <ProjectIcon project={preview} size={16} />
        <ProjectName project={preview}>{project.name}</ProjectName>
      </h2>
    </header>
    <section className="project-customize-section" aria-label="Colour">
      <h3>Colour</h3>
      <ProjectColorPicker value={preferences.color} onChange={(color) => apply({ color })} />
    </section>
    <section className="project-customize-section" aria-label="Colour shows on">
      <h3>Shows on</h3>
      <ProjectEmphasisPicker value={preferences.colorEmphasis} onChange={(colorEmphasis) => apply({ colorEmphasis })} />
    </section>
    <section className="project-customize-section" aria-label="Icon">
      <h3>Icon</h3>
      <div className="project-customize-icons">
        <ProjectIconPicker preferences={preferences} onChange={(icon) => apply({ icon })} />
        <button type="button" className="project-customize-action" onClick={() => fileInput.current?.click()}><ImagePlus size={13} aria-hidden="true" />Import image…</button>
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          readProjectIcon(file).then((data) => apply({ icon: { kind: "image", data } }))
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not read that image."));
        }} />
      </div>
    </section>
    <div className="project-customize-toggle">
      <span aria-hidden="true">Pin to top of project lists</span>
      <Switch label="Pin to top of project lists" checked={preferences.pinned} onChange={(pinned) => apply({ pinned })} />
    </div>
    {error && <p className="project-customize-error" role="alert">{error}</p>}
    {onOpenSettings && <button type="button" className="project-customize-action is-footer" onClick={() => onOpenSettings(project)}>
      <Settings size={13} aria-hidden="true" />All project settings</button>}
  </div>;
}
