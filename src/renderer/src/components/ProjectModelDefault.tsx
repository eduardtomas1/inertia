import { useMemo } from "react";
import type { AppSettings, ModelBackendDefault, ModelBackendProfileView, ModelSelection, ProviderInfo } from "@shared/contracts";
import { buildComposerModelRoutes, selectedModelSearchRoute } from "../utils/modelChooserRoutes";
import { defaultSelectionForProject } from "../utils/defaultConversationSelection";
import "./ProjectModelDefault.css";

interface ModelDefaultSelectProps {
  /** The saved default at this layer, if any. */
  saved: ModelSelection | undefined;
  /** What applies when this layer saves nothing. */
  inherited: ModelSelection;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  providerIdentityLabels: AppSettings["providerIdentityLabels"];
  modelLabel: string;
  reasoningLabel: string;
  disabled: boolean;
  inactive?: boolean;
  onChange(selection: ModelSelection | null): void;
}

/**
 * A layer's default model and reasoning, over the composer's exact
 * harness/backend catalog; never reconstructs a native route from its label.
 * "Default (…)" clears the layer so the inherited model applies.
 */
export function ModelDefaultSelect({
  saved,
  inherited: inheritedSelection,
  providers,
  backendProfiles,
  providerIdentityLabels,
  modelLabel,
  reasoningLabel,
  disabled,
  inactive = false,
  onChange,
}: ModelDefaultSelectProps): React.JSX.Element {
  const selection = saved ?? inheritedSelection;
  const routes = useMemo(() => buildComposerModelRoutes(providers, backendProfiles, selection, providerIdentityLabels),
    [providers, backendProfiles, selection, providerIdentityLabels]);
  const selected = selectedModelSearchRoute(routes, selection);
  const inherited = selectedModelSearchRoute(routes, inheritedSelection);
  const groups = new Map<string, typeof routes>();
  for (const route of routes) {
    const label = `${route.backendProfileName} · ${route.harnessLabel}`;
    const group = groups.get(label) ?? [];
    group.push(route);
    groups.set(label, group);
  }
  const reasoningOptions = routes.find(({ key }) => key === selected.key)?.reasoningOptions ?? [];
  return <div className="project-model-controls">
    <select className="setting-select" aria-label={modelLabel} value={saved ? selected.key : ""} disabled={disabled} aria-disabled={inactive || undefined} onChange={(event) => {
      if (inactive) return;
      if (!event.target.value) { onChange(null); return; }
      const route = routes.find(({ key }) => key === event.target.value);
      if (route?.selectable) onChange(route.selection);
    }}>
      <option value="">Default ({inherited.modelId === "provider-default" ? `${inherited.providerLabel} default` : inherited.displayName})</option>
      {saved && !routes.some(({ key }) => key === selected.key) && <option value={selected.key} disabled>{selected.displayName} — unavailable</option>}
      {[...groups].map(([label, choices]) => <optgroup key={label} label={label}>{choices.map((route) =>
        <option key={route.key} value={route.key} disabled={!route.selectable}>{route.displayName}{route.selectable ? "" : " — unavailable"}</option>)}</optgroup>)}
    </select>
    {saved && <select className="setting-select" aria-label={reasoningLabel} value={saved.reasoningEffort ?? ""}
      disabled={disabled || !selected.selectable || reasoningOptions.length === 0} aria-disabled={inactive || undefined} onChange={(event) => {
        if (inactive) return;
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

interface Props {
  projectId: string;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  backendDefaults: ModelBackendDefault[];
  settings: AppSettings;
  disabled: boolean;
  inactive?: boolean;
  onChange(selection: ModelSelection | null): void;
}

export function ProjectModelDefault({ projectId, providers, backendProfiles, backendDefaults, settings, disabled, inactive = false, onChange }: Props): React.JSX.Element {
  const saved = backendDefaults.find((item) => item.scope === "project" && item.projectId === projectId)?.selection;
  const inherited = defaultSelectionForProject({ providers, backendProfiles,
    backendDefaults: backendDefaults.filter((item) => item.scope !== "project") }, settings, projectId);
  return <ModelDefaultSelect saved={saved} inherited={inherited} providers={providers} backendProfiles={backendProfiles}
    providerIdentityLabels={settings.providerIdentityLabels} modelLabel="Model for this project" reasoningLabel="Project default reasoning"
    disabled={disabled} inactive={inactive} onChange={onChange} />;
}
