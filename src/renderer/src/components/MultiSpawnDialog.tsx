import { ChevronDown, TriangleAlert } from "lucide-react";
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
  DuoLaunchStatus,
  ModelSelection,
  ProviderId,
} from "@shared/contracts";
import {
  DUO_COMPARISON_CHANGED_FILES_MAX_ENTRIES,
  DUO_COMPARISON_PROMPT_MAX_CHARS,
} from "../../../shared/contracts/duo";
import { providerIdForHarness } from "../../../shared/model-routing";
import { accessModeUnavailableReason, effectiveAccessMode } from "../../../shared/access-modes";
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
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import {
  initialMultiSpawnDraft,
  multiSpawnDraftIssue,
  projectsShareLocalCheckout,
  readMultiSpawnPreset,
  refreshMultiSpawnSelection,
  type MultiSpawnDraft,
  type MultiSpawnDraftField,
  type IdentifiedDuoRecoveryGuidance,
  type MultiSpawnSideDraft,
} from "../utils/multiSpawn";
import { accessOptions } from "./composer/config";
import { defaultAccessModeForProject } from "../lib/newConversation";
import { MultiSpawnRecoveryPanel } from "./MultiSpawnRecoveryPanel";
import { ModelChooser } from "./ModelChooser";
import { DialogShell } from "./DialogShell";
import { LoadingMark, Switch } from "./ui";
import "./MultiSpawnDialog.css";

export interface MultiSpawnDialogProps {
  open: boolean;
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  submitting: boolean;
  cancelling?: boolean;
  launchBlocked?: boolean;
  offline?: boolean;
  error: string | null;
  recoveryGuidance?: IdentifiedDuoRecoveryGuidance[];
  recoveryStatus?: DuoLaunchStatus | null;
  recheckingRecovery?: boolean;
  acknowledgingRecovery?: boolean;
  retryingComparison?: boolean;
  cancellingComparison?: boolean;
  onClose: () => void;
  onSubmit: (draft: MultiSpawnDraft) => Promise<void>;
  onRecheckRecovery?: () => Promise<void>;
  onAcknowledgeRecovery?: () => Promise<void>;
  onRetryComparison?: () => Promise<void>;
  onCancelComparison?: () => Promise<void>;
  onOpenJudge?: (conversationId: string) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
}

type IssueField = MultiSpawnDraftField | `route-${0 | 1 | 2}`;

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

function MultiSpawnSideEditor({
  index,
  side,
  projects,
  routeState,
  disabled,
  invalidField,
  onChange,
  onRepair,
}: {
  index: 0 | 1 | 2;
  side: MultiSpawnSideDraft;
  projects: AppSnapshot["projects"];
  routeState: RouteState;
  disabled: boolean;
  invalidField: MultiSpawnDraftField | "route" | null;
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
  const chatLabel = index === 0 ? "Chat A" : index === 1 ? "Chat B" : "Judge";

  return (
    <section
      className="multi-spawn-side"
      data-route-side={index === 0 ? "a" : index === 1 ? "b" : "judge"}
      aria-labelledby={`multi-spawn-side-heading-${index}`}
    >
      <header>
        <span>
          <h3 id={`multi-spawn-side-heading-${index}`}>
            {chatLabel}
          </h3>
          <span>
            {routeState.selected.harnessLabel} ·{" "}
            {routeState.selected.backendProfileName}
          </span>
        </span>
        <span className={`multi-spawn-readiness ${ready ? "is-ready" : ""}`}>
          {ready ? "Ready" : routeState.statusBadge}
        </span>
      </header>

      <div className="multi-spawn-field-grid">
        <label className="multi-spawn-field multi-spawn-title-field" htmlFor={titleId}>
          <span>Chat name</span>
          <input
            id={titleId}
            aria-label={`${chatLabel} name`}
            value={side.title}
            maxLength={120}
            disabled={disabled}
            aria-invalid={invalidField === `title-${index}` || undefined}
            placeholder="Chat name"
            onChange={(event) => onChange({
              ...side,
              title: event.currentTarget.value,
            })}
          />
        </label>
        <label className="multi-spawn-field" htmlFor={projectId}>
          <span>Project</span>
          <select
            id={projectId}
            aria-label={`${chatLabel} project`}
            value={side.projectId}
            disabled={disabled}
            aria-invalid={invalidField === `project-${index}` || undefined}
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

      <div className="multi-spawn-route" data-invalid={invalidField === "route" || undefined}>
        <span className="multi-spawn-control-label">Model</span>
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
          <span>Reasoning</span>
          <select
            id={reasoningId}
            aria-label={`${chatLabel} reasoning`}
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
          <span>Access</span>
          <select
            id={accessId}
            aria-label={`${chatLabel} access`}
            value={effectiveAccessMode(providerIdForHarness(side.selection.harnessId) ?? "", side.accessMode)}
            disabled={disabled}
            onChange={(event) => onChange({
              ...side,
              accessMode: event.currentTarget.value as AccessMode,
            })}
          >
            {accessOptions.map((option) => (
              <option
                value={option.value}
                key={option.value}
                disabled={accessModeUnavailableReason(providerIdForHarness(side.selection.harnessId) ?? "", option.value) !== null}
              >
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
            <span>{routeState.statusDetail}</span>
          </span>
          {routeState.repairAction && routeState.providerId && (
            <button type="button" className="secondary-button" disabled={disabled} onClick={onRepair}>
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
  cancelling = false,
  launchBlocked = false,
  offline = false,
  error,
  recoveryGuidance = [],
  recoveryStatus = null,
  recheckingRecovery = false,
  acknowledgingRecovery = false,
  retryingComparison = false,
  cancellingComparison = false,
  onClose,
  onSubmit,
  onRecheckRecovery,
  onAcknowledgeRecovery,
  onRetryComparison,
  onCancelComparison,
  onOpenJudge,
  onOpenProviderSetup,
  onOpenBackendSetup,
}: MultiSpawnDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const initializedForOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const chosenAccessRef = useRef<[boolean, boolean]>([false, false]);
  const [draft, setDraft] = useState<MultiSpawnDraft | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const regularProjects = useMemo(() => (snapshot?.projects ?? [])
    .filter(({ workspaceKind }) => workspaceKind !== "scratch"), [snapshot?.projects]);
  useNativePreviewSuspension(true);
  const busy = submitting
    || cancelling
    || acknowledgingRecovery
    || retryingComparison
    || cancellingComparison;

  const routesForSelection = useMemo(() => (
    selection: ModelSelection,
  ) => buildComposerModelRoutes(
    snapshot?.providers ?? [],
    snapshot?.backendProfiles ?? [],
    selection,
    settings.providerIdentityLabels,
  ), [settings.providerIdentityLabels, snapshot?.backendProfiles, snapshot?.providers]);

  useEffect(() => {
    if (!open) {
      initializedForOpenRef.current = false;
      return;
    }
    if (
      initializedForOpenRef.current
      || !snapshot || regularProjects.length === 0
    ) return;
    initializedForOpenRef.current = true;
    setShowIssue(false);
    const preset = readMultiSpawnPreset(window.localStorage);
    chosenAccessRef.current = [Boolean(preset), Boolean(preset)];
    setDraft(initialMultiSpawnDraft({
      snapshot,
      settings,
      activeProjectId: regularProjects.find(({ id }) => id === snapshot.activeProjectId)?.id ?? regularProjects[0]!.id,
      routesForSelection,
      preset,
    }));
  }, [open, regularProjects, routesForSelection, settings, snapshot]);

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
      const comparison = refreshMultiSpawnSelection(
        routesForSelection(current.comparison.side.selection),
        current.comparison.side.selection,
      );
      if (
        first === current.sides[0].selection
        && second === current.sides[1].selection
        && comparison === current.comparison.side.selection
      ) return current;
      return {
        ...current,
        sides: [
          { ...current.sides[0], selection: first },
          { ...current.sides[1], selection: second },
        ],
        comparison: {
          ...current.comparison,
          side: {
            ...current.comparison.side,
            selection: comparison,
          },
        },
      };
    });
  }, [open, routesForSelection]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = true;
    const restoreFocus = captureModalFocus();
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const active = document.activeElement;
      if (
        !dialog
        || !(active instanceof HTMLElement)
        || !dialog.contains(active)
      ) {
        promptRef.current?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (restoreFocusRef.current) restoreFocus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const nested = event.target instanceof Element
          ? event.target.closest('[role="dialog"]')
          : null;
        if (nested && nested !== dialogRef.current && dialogRef.current?.contains(nested)) return;
        // Own Escape before an underlying mobile sidebar can dismiss itself
        // and unmount the trigger that should receive restored focus.
        event.stopImmediatePropagation();
        event.preventDefault();
        if (!cancelling) onClose();
        return;
      }
      if (dialogRef.current) trapModalFocus(event, dialogRef.current);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelling, onClose, open]);

  if (!snapshot || !draft) return null;

  const routeStateFor = (side: MultiSpawnSideDraft): RouteState => {
    const providerId = providerIdForHarness(side.selection.harnessId);
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
          ?? (routeSelectable ? "Model ready" : "Model unavailable")
        : "Model unavailable",
      statusDetail: exactRoute
        ? readinessIssue?.detail
          ?? exactRoute.unavailableReason
          ?? "The selected model is ready."
        : selected.unavailableReason
          ?? "Choose a model that is available now.",
    };
  };
  const routeStates: [RouteState, RouteState] = [
    routeStateFor(draft.sides[0]),
    routeStateFor(draft.sides[1]),
  ];
  const comparisonRouteState = routeStateFor(draft.comparison.side);
  const unreadyRoute = ([0, 1, 2] as const).find((index) => index === 2
    ? draft.comparison.enabled && !comparisonRouteState.ready
    : !routeStates[index].ready);
  const issue: { field: IssueField; message: string } | null = multiSpawnDraftIssue(draft)
    ?? (unreadyRoute === undefined
      ? null
      : {
          field: `route-${unreadyRoute}`,
          message: unreadyRoute === 2
            ? "Choose a ready model for the judge."
            : `Choose a ready model for chat ${unreadyRoute === 0 ? "A" : "B"}.`,
        });
  const visibleIssue = showIssue && !submitting ? issue : null;
  const invalidFieldFor = (index: 0 | 1 | 2): MultiSpawnDraftField | "route" | null => {
    if (!visibleIssue) return null;
    if (visibleIssue.field === `route-${index}`) return "route";
    return visibleIssue.field.endsWith(`-${index}`)
      ? visibleIssue.field as MultiSpawnDraftField
      : null;
  };
  const sharesLocalCheckout = settings.newThreadMode === "local"
    && projectsShareLocalCheckout(
      snapshot.projects,
      draft.sides[0].projectId,
      draft.sides[1].projectId,
    );
  const judgeSharesSourceCheckout = draft.comparison.enabled
    && draft.comparison.side.accessMode !== "supervised"
    && draft.sides.some((side) => projectsShareLocalCheckout(
      snapshot.projects,
      side.projectId,
      draft.comparison.side.projectId,
    ));
  const statusMessage = error && error !== recoveryStatus?.comparison?.error
    ? error
    : null;
  const updateSide = (
    index: 0 | 1,
    next: MultiSpawnSideDraft,
  ): void => {
    const previous = draft.sides[index];
    if (next.accessMode !== previous.accessMode) chosenAccessRef.current[index] = true;
    const side = next.projectId !== previous.projectId && !chosenAccessRef.current[index]
      ? {
          ...next,
          accessMode: defaultAccessModeForProject(
            snapshot.projects.find(({ id }) => id === next.projectId),
            settings,
          ),
        }
      : next;
    setDraft((current) => current ? {
      ...current,
      sides: index === 0
        ? [side, current.sides[1]]
        : [current.sides[0], side],
    } : current);
  };

  const updateComparison = (next: MultiSpawnSideDraft): void => {
    setDraft((current) => current ? {
      ...current,
      comparison: {
        ...current.comparison,
        side: next,
      },
    } : current);
  };

  const openRepair = (index: 0 | 1 | 2): void => {
    const route = index === 2 ? comparisonRouteState : routeStates[index];
    const side = index === 2 ? draft.comparison.side : draft.sides[index];
    restoreFocusRef.current = false;
    onClose();
    if (
      route.ready
      || !route.repairAction
      || !route.providerId
    ) return;
    if (
      route.repairAction === "add-key"
      || route.repairAction === "configure"
      || route.repairAction === "probe"
    ) {
      onOpenBackendSetup(side.selection.backendProfileId);
    } else {
      onOpenProviderSetup(route.providerId);
    }
  };

  const focusIssue = (field: IssueField): void => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (field.endsWith("-2")) {
      const judgeConfig = dialog.querySelector<HTMLDetailsElement>(".multi-spawn-judge-config");
      if (judgeConfig) judgeConfig.open = true;
    }
    const target = field === "prompt"
      ? promptRef.current
      : field.startsWith("route-")
        ? dialog.querySelector<HTMLElement>(
            `[data-route-side="${field === "route-0" ? "a" : field === "route-1" ? "b" : "judge"}"] .multi-spawn-route button`,
          )
        : dialog.querySelector<HTMLElement>(`#multi-spawn-${field}`);
    target?.focus();
  };

  const submitDraft = (): void => {
    if (issue) {
      setShowIssue(true);
      focusIssue(issue.field);
      return;
    }
    setShowIssue(false);
    restoreFocusRef.current = false;
    void onSubmit(draft).finally(() => {
      if (dialogRef.current?.isConnected) {
        restoreFocusRef.current = true;
      }
    });
  };

  return (
    <DialogShell
      ref={dialogRef}
      className="multi-spawn-dialog"
      backdropClassName="multi-spawn-backdrop"
      bodyClassName="multi-spawn-dialog-body is-flush"
      titleId="multi-spawn-title"
      title="New duo"
      closeLabel="Close new duo"
      closeDisabled={cancelling}
      onClose={onClose}
      onDismiss={() => { if (!submitting && !cancelling) onClose(); }}
      trapFocus={false}
      footerStart={(
        <label className="multi-spawn-preset-toggle">
          <input
            type="checkbox"
            checked={draft.rememberPreset}
            disabled={busy}
            onChange={(event) => setDraft({
              ...draft,
              rememberPreset: event.currentTarget.checked,
            })}
          />
          <span>
            Remember this setup
            <small>Keeps names, models, access and the judge. Not the brief or the projects.</small>
          </span>
        </label>
      )}
      footer={<>
        <p className="multi-spawn-footer-status" role="status">
          {visibleIssue?.message}
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={cancelling}
          onClick={onClose}
        >
          {cancelling ? "Cancelling…" : submitting ? "Cancel launch" : "Cancel"}
        </button>
        <button
          type="button"
          className="primary-button multi-spawn-launch"
          disabled={busy || launchBlocked || offline}
          onClick={submitDraft}
        >
          {submitting ? <LoadingMark label="Starting duo" /> : null}
          {submitting ? "Starting…" : "Start duo"}
        </button>
      </>}
    >
      <div className="multi-spawn-prompt-zone">
        <label htmlFor="multi-spawn-prompt">
          <span>Brief</span>
          <small>{draft.prompt.trim().length.toLocaleString("en-US")} / 20,000</small>
        </label>
        <textarea
          ref={promptRef}
          id="multi-spawn-prompt"
          aria-label="Brief for both chats"
          aria-invalid={visibleIssue?.field === "prompt" || undefined}
          value={draft.prompt}
          maxLength={20_000}
          disabled={busy}
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
          projects={regularProjects}
          routeState={routeStates[0]}
          disabled={busy}
          invalidField={invalidFieldFor(0)}
          onChange={(next) => updateSide(0, next)}
          onRepair={() => openRepair(0)}
        />
        <MultiSpawnSideEditor
          index={1}
          side={draft.sides[1]}
          projects={regularProjects}
          routeState={routeStates[1]}
          disabled={busy}
          invalidField={invalidFieldFor(1)}
          onChange={(next) => updateSide(1, next)}
          onRepair={() => openRepair(1)}
        />
      </div>

      <section
        className={`multi-spawn-comparison${draft.comparison.enabled ? " is-enabled" : ""}`}
        aria-labelledby="multi-spawn-comparison-title"
      >
        <div className="multi-spawn-comparison-toggle">
          <Switch
            id="multi-spawn-comparison-switch"
            checked={draft.comparison.enabled}
            disabled={busy}
            onChange={(enabled) => setDraft({
              ...draft,
              comparison: {
                ...draft.comparison,
                enabled,
              },
            })}
          />
          <span>
            <h3 id="multi-spawn-comparison-title">
              <label htmlFor="multi-spawn-comparison-switch">Add an independent judge</label>
            </h3>
          </span>
        </div>

        {draft.comparison.enabled && (
          <div className="multi-spawn-comparison-body">
            <details className="multi-spawn-judge-config">
              <summary>
                <span>Independent judge</span>
                <span className="multi-spawn-judge-config-action">
                  Configure judge
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </summary>
              <MultiSpawnSideEditor
                index={2}
                side={draft.comparison.side}
                projects={regularProjects}
                routeState={comparisonRouteState}
                disabled={busy}
                invalidField={invalidFieldFor(2)}
                onChange={updateComparison}
                onRepair={() => openRepair(2)}
              />
            </details>
            {judgeSharesSourceCheckout && (
              <div className="multi-spawn-judge-risk" role="status">
                <TriangleAlert size={14} />
                <span>
                  <strong>Judge can edit a source checkout</strong>
                  Full access can modify this checkout. Choose Supervised to
                  keep comparison read-only.
                </span>
              </div>
            )}
            <details className="multi-spawn-lock-contract">
              <summary>What is shared with the judge?</summary>
              <p>
                When A and B finish, Inertia sends the judge one message of
                up to {DUO_COMPARISON_PROMPT_MAX_CHARS.toLocaleString("en-US")}
                {" "}characters for both chats: the brief, each chat&apos;s
                status and final answer, where each chat worked, and up to
                {" "}{DUO_COMPARISON_CHANGED_FILES_MAX_ENTRIES} changed files
                from each. It sends no source session, reasoning, tool
                history, permissions, credentials, attachments, or hidden
                context.
              </p>
              <p>
                The judge uses only its own project, model, and access, and
                may inspect the folders of A and B read-only. They can&apos;t be
                deleted while the judge runs.
              </p>
            </details>
          </div>
        )}
      </section>

      {sharesLocalCheckout && (
        <div className="multi-spawn-dialog-status" role="status">
          A and B will share this project folder, so their edits can overlap.
        </div>
      )}

      {(statusMessage || recoveryStatus || recoveryGuidance.length > 0) && (
        <div className="multi-spawn-dialog-status">
          {statusMessage && <p className="multi-spawn-dialog-error" role="alert">{statusMessage}</p>}
          {(recoveryStatus || recoveryGuidance.length > 0) && (
            <MultiSpawnRecoveryPanel
              recoveryStatus={recoveryStatus}
              recoveryGuidance={recoveryGuidance}
              busy={busy}
              recheckingRecovery={recheckingRecovery}
              acknowledgingRecovery={acknowledgingRecovery}
              retryingComparison={retryingComparison}
              cancellingComparison={cancellingComparison}
              onRecheckRecovery={onRecheckRecovery}
              onAcknowledgeRecovery={onAcknowledgeRecovery}
              onRetryComparison={onRetryComparison}
              onCancelComparison={onCancelComparison}
              onOpenJudge={onOpenJudge && ((conversationId) => {
                restoreFocusRef.current = false;
                onClose();
                onOpenJudge(conversationId);
              })}
            />
          )}
        </div>
      )}
    </DialogShell>
  );
}
