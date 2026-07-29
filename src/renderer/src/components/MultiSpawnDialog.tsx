import {
  ArrowRight,
  Brain,
  Check,
  Folder,
  KeyRound,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AccessMode,
  AppSettings,
  AppSnapshot,
  ModelSelection,
  ProviderId,
} from "@shared/contracts";
import { legacyProviderIdForHarness } from "../../../shared/model-routing";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  composerRouteReadiness,
  type ComposerRouteRepair,
} from "../utils/composerReadiness";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../utils/modelChooserRoutes";
import {
  initialMultiSpawnDraft,
  projectsShareLocalCheckout,
  readMultiSpawnPreset,
  refreshMultiSpawnSelection,
  validateMultiSpawnDraft,
  type MultiSpawnDraft,
  type MultiSpawnSideDraft,
} from "../utils/multiSpawn";
import { accessOptions } from "./composer/config";
import { ModelChooser } from "./ModelChooser";
import { IconButton, LoadingMark } from "./ui";

export interface MultiSpawnDialogProps {
  open: boolean;
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: MultiSpawnDraft) => Promise<void>;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
}

interface RouteState {
  routes: ComposerModelRoute[];
  selected: ReturnType<typeof selectedModelSearchRoute>;
  providerId: ProviderId | null;
  ready: boolean;
  repairAction: ComposerRouteRepair | null;
  statusBadge: string;
  statusTitle: string;
  statusDetail: string;
}

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: { ...selection.providerOptions },
    capabilities: selection.capabilities.map(
      (capability) => ({ ...capability }),
    ),
  };
}

function reasoningLabel(value: string): string {
  if (!value) return "Provider default";
  return value
    .split(/[-_]/u)
    .map((part) => part
      ? part[0]!.toLocaleUpperCase("en-US") + part.slice(1)
      : part)
    .join(" ");
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), "
      + "textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hasAttribute("hidden"));
}

function MultiSpawnSideEditor({
  index,
  side,
  projects,
  routeState,
  disabled,
  onChange,
  onRepair,
}: {
  index: 0 | 1;
  side: MultiSpawnSideDraft;
  projects: AppSnapshot["projects"];
  routeState: RouteState;
  disabled: boolean;
  onChange: (next: MultiSpawnSideDraft) => void;
  onRepair: () => void;
}): React.JSX.Element {
  const titleId = `multi-spawn-title-${index}`;
  const projectId = `multi-spawn-project-${index}`;
  const reasoningId = `multi-spawn-reasoning-${index}`;
  const accessId = `multi-spawn-access-${index}`;
  const route = routeState.routes.find((candidate) =>
    candidate.harnessId === side.selection.harnessId
    && candidate.backendProfileId === side.selection.backendProfileId
    && candidate.modelId === side.selection.modelId
    && candidate.selection.backendConfigurationRevision
      === side.selection.backendConfigurationRevision);
  const reasoningOptions = route?.reasoningOptions ?? [];
  const ready = routeState.ready;

  return (
    <section
      className="multi-spawn-side"
      aria-labelledby={`multi-spawn-side-heading-${index}`}
    >
      <header>
        <span className="multi-spawn-side-number">{index + 1}</span>
        <span>
          <strong id={`multi-spawn-side-heading-${index}`}>
            {index === 0 ? "First perspective" : "Second perspective"}
          </strong>
          <small>
            {routeState.selected.harnessLabel} ·{" "}
            {routeState.selected.backendProfileName}
          </small>
        </span>
        <span className={`multi-spawn-readiness ${ready ? "is-ready" : ""}`}>
          {ready ? <Check size={11} /> : <KeyRound size={11} />}
          {ready ? "Ready" : routeState.statusBadge}
        </span>
      </header>

      <div className="multi-spawn-field-grid">
        <label className="multi-spawn-field multi-spawn-title-field" htmlFor={titleId}>
          <span>Chat name</span>
          <input
            id={titleId}
            aria-label={`Chat ${index + 1} name`}
            value={side.title}
            maxLength={120}
            disabled={disabled}
            placeholder={index === 0 ? "Implementation review" : "Second opinion"}
            onChange={(event) => onChange({
              ...side,
              title: event.currentTarget.value,
            })}
          />
        </label>
        <label className="multi-spawn-field" htmlFor={projectId}>
          <span><Folder size={11} /> Project</span>
          <select
            id={projectId}
            aria-label={`Chat ${index + 1} project`}
            value={side.projectId}
            disabled={disabled}
            onChange={(event) => onChange({
              ...side,
              projectId: event.currentTarget.value,
            })}
          >
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="multi-spawn-route">
        <span className="multi-spawn-control-label">Model route</span>
        <ModelChooser
          routes={routeState.routes}
          selectedRoute={routeState.selected}
          disabled={disabled}
          onSelect={(nextRoute) => onChange({
            ...side,
            selection: cloneSelection(nextRoute.selection),
          })}
        />
      </div>

      <div className="multi-spawn-field-grid is-compact">
        <label className="multi-spawn-field" htmlFor={reasoningId}>
          <span><Brain size={11} /> Reasoning</span>
          <select
            id={reasoningId}
            aria-label={`Chat ${index + 1} reasoning`}
            value={side.selection.reasoningEffort ?? ""}
            disabled={disabled || reasoningOptions.length === 0}
            onChange={(event) => onChange({
              ...side,
              selection: {
                ...side.selection,
                reasoningEffort: event.currentTarget.value || null,
              },
            })}
          >
            <option value="">Provider default</option>
            {reasoningOptions.map((effort) => (
              <option value={effort} key={effort}>
                {reasoningLabel(effort)}
              </option>
            ))}
          </select>
        </label>
        <label className="multi-spawn-field" htmlFor={accessId}>
          <span><ShieldCheck size={11} /> Access</span>
          <select
            id={accessId}
            aria-label={`Chat ${index + 1} access`}
            value={side.accessMode}
            disabled={disabled}
            onChange={(event) => onChange({
              ...side,
              accessMode: event.currentTarget.value as AccessMode,
            })}
          >
            {accessOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!ready && (
        <div className="multi-spawn-route-warning" role="status">
          <span>
            <strong>{routeState.statusTitle}</strong>
            <small>{routeState.statusDetail}</small>
          </span>
          {routeState.repairAction && routeState.providerId && (
            <button type="button" disabled={disabled} onClick={onRepair}>
              Open setup
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function MultiSpawnDialog({
  open,
  snapshot,
  settings,
  submitting,
  error,
  onClose,
  onSubmit,
  onOpenProviderSetup,
  onOpenBackendSetup,
}: MultiSpawnDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const initializedForOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const [draft, setDraft] = useState<MultiSpawnDraft | null>(null);
  useNativePreviewSuspension(open);

  const routesForSelection = useMemo(() => (
    selection: ModelSelection,
  ) => buildComposerModelRoutes(
    snapshot?.providers ?? [],
    snapshot?.backendProfiles ?? [],
    selection,
  ), [snapshot?.backendProfiles, snapshot?.providers]);

  useEffect(() => {
    if (!open) {
      initializedForOpenRef.current = false;
      return;
    }
    if (
      initializedForOpenRef.current
      || !snapshot?.activeProjectId
    ) return;
    initializedForOpenRef.current = true;
    setDraft(initialMultiSpawnDraft({
      snapshot,
      settings,
      activeProjectId: snapshot.activeProjectId,
      routesForSelection,
      preset: readMultiSpawnPreset(window.localStorage),
    }));
  }, [open, routesForSelection, settings, snapshot]);

  useEffect(() => {
    if (!open) return;
    setDraft((current) => {
      if (!current) return current;
      const first = refreshMultiSpawnSelection(
        routesForSelection(current.sides[0].selection),
        current.sides[0].selection,
      );
      const second = refreshMultiSpawnSelection(
        routesForSelection(current.sides[1].selection),
        current.sides[1].selection,
      );
      if (
        first === current.sides[0].selection
        && second === current.sides[1].selection
      ) return current;
      return {
        ...current,
        sides: [
          { ...current.sides[0], selection: first },
          { ...current.sides[1], selection: second },
        ],
      };
    });
  }, [open, routesForSelection]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = true;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(
      () => promptRef.current?.focus(),
    );
    return () => {
      window.cancelAnimationFrame(frame);
      if (restoreFocusRef.current && previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, submitting]);

  if (!open || !snapshot || !draft) return null;

  const routeStates = draft.sides.map((side): RouteState => {
    const providerId = legacyProviderIdForHarness(side.selection.harnessId);
    const provider = snapshot.providers.find(({ id }) => id === providerId);
    const profile = snapshot.backendProfiles?.find(
      ({ id }) => id === side.selection.backendProfileId,
    );
    const routes = routesForSelection(side.selection);
    const selected = selectedModelSearchRoute(routes, side.selection);
    const exactRoute = routes.find((candidate) =>
      candidate.harnessId === side.selection.harnessId
      && candidate.backendProfileId === side.selection.backendProfileId
      && candidate.modelId === side.selection.modelId
      && candidate.selection.backendConfigurationRevision
        === side.selection.backendConfigurationRevision);
    const readiness = composerRouteReadiness({
      provider,
      profile,
      selection: side.selection,
    });
    const readinessIssue = readiness.ready ? null : readiness;
    const routeSelectable = exactRoute?.selectable === true;
    return {
      routes,
      selected,
      providerId,
      ready: routeSelectable && readiness.ready,
      repairAction: exactRoute
        ? readinessIssue?.action ?? null
        : null,
      statusBadge: exactRoute
        ? readinessIssue?.badge
          ?? (routeSelectable ? "Ready" : "Unavailable")
        : "Select model",
      statusTitle: exactRoute
        ? readinessIssue?.title
          ?? (routeSelectable ? "Route ready" : "Model route unavailable")
        : "Model route unavailable",
      statusDetail: exactRoute
        ? readinessIssue?.detail
          ?? exactRoute.unavailableReason
          ?? "The selected route is ready."
        : selected.unavailableReason
          ?? "Choose a model route that is currently available.",
    };
  }) as [RouteState, RouteState];
  const validationError = validateMultiSpawnDraft(draft);
  const routesReady = routeStates.every(({ ready }) => ready);
  const sharesLocalCheckout = settings.newThreadMode === "local"
    && projectsShareLocalCheckout(
      snapshot.projects,
      draft.sides[0].projectId,
      draft.sides[1].projectId,
    );

  const updateSide = (
    index: 0 | 1,
    next: MultiSpawnSideDraft,
  ): void => {
    setDraft((current) => current ? {
      ...current,
      sides: index === 0
        ? [next, current.sides[1]]
        : [current.sides[0], next],
    } : current);
  };

  const openRepair = (index: 0 | 1): void => {
    const route = routeStates[index];
    restoreFocusRef.current = false;
    onClose();
    if (
      route.ready
      || !route.repairAction
      || !route.providerId
    ) return;
    if (
      route.repairAction === "add-key"
      || route.repairAction === "probe"
    ) {
      onOpenBackendSetup(draft.sides[index].selection.backendProfileId);
    } else {
      onOpenProviderSetup(route.providerId);
    }
  };

  const submitDraft = (): void => {
    restoreFocusRef.current = false;
    void onSubmit(draft).finally(() => {
      if (dialogRef.current?.isConnected) {
        restoreFocusRef.current = true;
      }
    });
  };

  return (
    <div
      className="dialog-backdrop multi-spawn-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="multi-spawn-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="multi-spawn-title"
        aria-describedby="multi-spawn-description"
      >
        <header className="multi-spawn-dialog-header">
          <span className="multi-spawn-dialog-mark">
            <Zap size={17} fill="currentColor" />
          </span>
          <span>
            <h2 id="multi-spawn-title">Launch two perspectives</h2>
            <p id="multi-spawn-description">
              One prompt, two independent agent routes, one split workspace.
            </p>
          </span>
          <IconButton
            label="Close multi-spawn"
            disabled={submitting}
            onClick={onClose}
          >
            <X size={16} />
          </IconButton>
        </header>

        <div className="multi-spawn-prompt-zone">
          <label htmlFor="multi-spawn-prompt">
            <span><Sparkles size={12} /> Shared prompt</span>
            <small>{draft.prompt.trim().length.toLocaleString("en-US")} / 20,000</small>
          </label>
          <textarea
            ref={promptRef}
            id="multi-spawn-prompt"
            aria-label="Shared prompt"
            value={draft.prompt}
            maxLength={20_000}
            disabled={submitting}
            placeholder="Ask both agents to inspect, implement, compare, or review the same work…"
            onChange={(event) => setDraft({
              ...draft,
              prompt: event.currentTarget.value,
            })}
          />
        </div>

        <div className="multi-spawn-sides">
          <MultiSpawnSideEditor
            index={0}
            side={draft.sides[0]}
            projects={snapshot.projects}
            routeState={routeStates[0]}
            disabled={submitting}
            onChange={(next) => updateSide(0, next)}
            onRepair={() => openRepair(0)}
          />
          <span className="multi-spawn-pair-arrow" aria-hidden="true">
            <ArrowRight size={15} />
          </span>
          <MultiSpawnSideEditor
            index={1}
            side={draft.sides[1]}
            projects={snapshot.projects}
            routeState={routeStates[1]}
            disabled={submitting}
            onChange={(next) => updateSide(1, next)}
            onRepair={() => openRepair(1)}
          />
        </div>

        {sharesLocalCheckout && (
          <div className="multi-spawn-dialog-status" role="status">
            Both agents will share this project checkout. Concurrent edits can
            overlap; choose different projects or enable isolated worktrees in
            Settings when you need independent changes.
          </div>
        )}

        {(error || (!routesReady && !submitting)) && (
          <div
            className={`multi-spawn-dialog-status${error ? " is-error" : ""}`}
            role={error ? "alert" : "status"}
          >
            {error
              ?? "Choose two ready routes before launching the duo."}
          </div>
        )}

        <footer className="multi-spawn-dialog-footer">
          <label className="multi-spawn-preset-toggle">
            <input
              type="checkbox"
              checked={draft.rememberPreset}
              disabled={submitting}
              onChange={(event) => setDraft({
                ...draft,
                rememberPreset: event.currentTarget.checked,
              })}
            />
            <span>
              <strong>Use as my default duo</strong>
              <small>Saves names, routes, reasoning, and access locally.</small>
            </span>
          </label>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button multi-spawn-launch"
              disabled={submitting || Boolean(validationError) || !routesReady}
              title={validationError ?? (!routesReady
                ? "Both routes must be ready."
                : undefined)}
              onClick={submitDraft}
            >
              {submitting ? <LoadingMark label="Launching duo" /> : <Zap size={14} />}
              {submitting ? "Launching duo…" : "Launch duo"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
