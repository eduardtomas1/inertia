import { useId, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import clsx from "clsx";
import type { AppSettings, AppSnapshot, ModelSelection } from "@shared/contracts";
import { effectiveNewChatDefault } from "@shared/new-chat-default";
import {
  fastModeProviderValue,
  providerIdForHarness,
  routeSupportsNativeFastModeIdentity,
  withModelSelectionFastMode,
} from "@shared/model-routing";

import { projectNameFromPath } from "../../lib/format";
import { composerRouteReadiness } from "../../utils/composerReadiness";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
} from "../../utils/modelChooserRoutes";
import { ModelChooser } from "../ModelChooser";
import { projectForFolder } from "./taskModel";

export type TaskStartTarget =
  | { kind: "project"; projectId: string }
  | { kind: "folder"; path: string };

export interface TaskHandoffProps {
  snapshot: AppSnapshot;
  settings: AppSettings;
  defaultProjectId: string | null;
  disabled: boolean;
  onStart: (target: TaskStartTarget, selection: ModelSelection) => Promise<void>;
  onError: (message: string) => void;
}

function capitalized(value: string): string {
  return value ? value[0]!.toLocaleUpperCase("en-US") + value.slice(1) : value;
}

export function TaskHandoff({
  snapshot,
  settings,
  defaultProjectId,
  disabled,
  onStart,
  onError,
}: TaskHandoffProps): React.JSX.Element {
  const labelId = useId();
  const projects = useMemo(
    () => snapshot.projects.filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [snapshot.projects],
  );
  const [chosenTarget, setChosenTarget] = useState<TaskStartTarget | null>(null);
  const [chosenSelection, setChosenSelection] = useState<ModelSelection | null>(null);
  const [starting, setStarting] = useState(false);
  const target: TaskStartTarget | null = chosenTarget?.kind === "folder"
    || (chosenTarget && projects.some(({ id }) => id === chosenTarget.projectId))
    ? chosenTarget
    : defaultProjectId ? { kind: "project", projectId: defaultProjectId } : null;
  const projectId = target?.kind === "project" ? target.projectId : null;
  const selection = useMemo(
    () => chosenSelection ?? effectiveNewChatDefault(snapshot, settings, projectId).selection,
    [chosenSelection, projectId, settings, snapshot],
  );
  const routes = useMemo(() => buildComposerModelRoutes(
    snapshot.providers,
    snapshot.backendProfiles ?? [],
    selection,
    settings.providerIdentityLabels,
  ), [selection, settings.providerIdentityLabels, snapshot.backendProfiles, snapshot.providers]);
  const route = routes.find((candidate) =>
    candidate.harnessId === selection.harnessId
    && candidate.backendProfileId === selection.backendProfileId
    && candidate.modelId === selection.modelId
    && candidate.selection.backendConfigurationRevision === selection.backendConfigurationRevision);
  const providerId = providerIdForHarness(selection.harnessId);
  const provider = snapshot.providers.find(({ id }) => id === providerId);
  const profile = snapshot.backendProfiles?.find(({ id }) => id === selection.backendProfileId);
  const ready = route?.selectable === true
    && composerRouteReadiness({ provider, profile, selection }).ready;
  const providerModel = provider?.models.find(({ id, isDefault }) => (
    selection.modelId === "provider-default" ? isDefault : id === selection.modelId
  ));
  const reasoningOptionLabels = new Map(
    (providerModel?.reasoningOptions
      ?? profile?.models.find(({ id }) => id === selection.modelId)?.reasoningOptions
      ?? []).map(({ value, label }) => [value, label]),
  );
  const reasoningOptions = route?.reasoningOptions ?? [];
  const fastAvailable = route?.supportsNativeFastModeControl === true
    && routeSupportsNativeFastModeIdentity(selection);
  const busy = disabled || starting;

  const report = (error: unknown): void => {
    onError(error instanceof Error ? error.message : "That action could not be completed.");
  };

  const pickFolder = async (): Promise<void> => {
    const path = await window.inertia.selectDirectory();
    if (!path) return;
    const known = projectForFolder(projects, path);
    setChosenTarget(known ? { kind: "project", projectId: known.id } : { kind: "folder", path });
  };

  const start = (): void => {
    if (!target || !ready) return;
    setStarting(true);
    void onStart(target, selection).catch(report).finally(() => setStarting(false));
  };

  return (
    <div className="task-handoff" role="group" aria-labelledby={labelId}>
      <p className="task-handoff-label" id={labelId}>Hand it to an agent</p>
      <div className="task-handoff-grid">
        <ModelChooser
          routes={routes}
          selectedRoute={selectedModelSearchRoute(routes, selection)}
          disabled={busy}
          onSelect={(next) => setChosenSelection({
            ...next.selection,
            providerOptions: { ...next.selection.providerOptions },
            capabilities: next.selection.capabilities.map((capability) => ({ ...capability })),
          })}
        />
        <select
          aria-label="Reasoning"
          className={clsx("task-handoff-control", !fastAvailable && "is-wide")}
          value={selection.reasoningEffort ?? ""}
          disabled={busy || reasoningOptions.length === 0}
          onChange={(event) => setChosenSelection({
            ...selection,
            reasoningEffort: event.currentTarget.value || null,
          })}
        >
          <option value="">Default</option>
          {reasoningOptions.map((effort) => (
            <option value={effort} key={effort}>
              {reasoningOptionLabels.get(effort) ?? capitalized(effort)}
            </option>
          ))}
        </select>
        {fastAvailable && (
          <select
            aria-label="Speed"
            className="task-handoff-control"
            value={fastModeProviderValue(selection) ? "fast" : "standard"}
            disabled={busy}
            onChange={(event) => setChosenSelection(withModelSelectionFastMode(
              selection,
              event.currentTarget.value === "fast" ? providerModel?.fastMode?.providerValue ?? null : null,
            ))}
          >
            <option value="standard">Standard</option>
            <option value="fast">Fast</option>
          </select>
        )}
        <select
          aria-label="Project"
          className="task-handoff-control"
          value={target?.kind === "folder" ? "folder" : projectId ?? ""}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value !== "folder") setChosenTarget({ kind: "project", projectId: value });
          }}
        >
          {!target && <option value="" disabled>No project</option>}
          {projects.map((project) => (
            <option value={project.id} key={project.id}>{project.name}</option>
          ))}
          {target?.kind === "folder" && (
            <option value="folder">{projectNameFromPath(target.path)}</option>
          )}
        </select>
        <button type="button" className="task-handoff-control" disabled={busy} onClick={() => void pickFolder().catch(report)}>
          <FolderOpen size={14} aria-hidden="true" />
          Folder…
        </button>
      </div>
      <div className="task-handoff-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !target || !ready}
          aria-busy={starting || undefined}
          onClick={start}
        >
          Start
        </button>
      </div>
    </div>
  );
}
