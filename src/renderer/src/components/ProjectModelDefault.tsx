import { useMemo } from "react";
import type { AppSettings, ModelBackendDefault, ModelBackendProfileView, ModelSelection, ProviderInfo } from "@shared/contracts";
import { buildComposerModelRoutes, selectedModelSearchRoute } from "../utils/modelChooserRoutes";
import { defaultSelectionForProject } from "../utils/defaultConversationSelection";

interface Props {
  projectId: string;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  backendDefaults: ModelBackendDefault[];
  settings: AppSettings;
  disabled: boolean;
  onChange(selection: ModelSelection | null): void;
}

/** Uses the composer's exact harness/backend catalog, never reconstructs a native route from its label. */
export function ProjectModelDefault({ projectId, providers, backendProfiles, backendDefaults, settings, disabled, onChange }: Props): React.JSX.Element {
  const saved = backendDefaults.find((item) => item.scope === "project" && item.projectId === projectId)?.selection;
  const selection = saved ?? defaultSelectionForProject({ providers, backendProfiles, backendDefaults }, settings, projectId);
  const routes = useMemo(() => buildComposerModelRoutes(providers, backendProfiles, selection, settings.providerIdentityLabels),
    [providers, backendProfiles, selection, settings.providerIdentityLabels]);
  const selected = selectedModelSearchRoute(routes, selection);
  const inherited = selectedModelSearchRoute(routes, defaultSelectionForProject({ providers, backendProfiles,
    backendDefaults: backendDefaults.filter((item) => item.scope !== "project") }, settings, projectId));
  const groups = new Map<string, typeof routes>();
  for (const route of routes) {
    const label = `${route.backendProfileName} · ${route.harnessLabel}`;
    const group = groups.get(label) ?? [];
    group.push(route);
    groups.set(label, group);
  }
  const reasoningOptions = routes.find(({ key }) => key === selected.key)?.reasoningOptions ?? [];
  return <div className="project-model-controls">
    <select aria-label="Project default model" value={saved ? selected.key : ""} disabled={disabled} onChange={(event) => {
      if (!event.target.value) { onChange(null); return; }
      const route = routes.find(({ key }) => key === event.target.value);
      if (route?.selectable) onChange(route.selection);
    }}>
      <option value="">Inherit ({inherited.displayName})</option>
      {saved && !routes.some(({ key }) => key === selected.key) && <option value={selected.key} disabled>{selected.displayName} — unavailable</option>}
      {[...groups].map(([label, choices]) => <optgroup key={label} label={label}>{choices.map((route) =>
        <option key={route.key} value={route.key} disabled={!route.selectable}>{route.displayName}{route.selectable ? "" : " — unavailable"}</option>)}</optgroup>)}
    </select>
    {saved && <select aria-label="Project default reasoning" value={saved.reasoningEffort ?? ""}
      disabled={disabled || !selected.selectable || reasoningOptions.length === 0} onChange={(event) => {
        const value = event.target.value;
        if (value && !reasoningOptions.includes(value)) return;
        onChange({ ...saved, reasoningEffort: value || null });
      }}>
      <option value="">Model default</option>
      {saved.reasoningEffort && !reasoningOptions.includes(saved.reasoningEffort) && <option value={saved.reasoningEffort} disabled>{saved.reasoningEffort} — unavailable</option>}
      {reasoningOptions.map((value) => <option key={value} value={value}>{value}</option>)}
    </select>}
  </div>;
}
