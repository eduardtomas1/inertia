import {
  ArrowLeftRight,
  Brain,
  Check,
  Columns2,
  Folder,
  KeyRound,
  Scale,
  ShieldCheck,
  TriangleAlert,
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
  DuoLaunchStatus,
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
  type IdentifiedDuoRecoveryGuidance,
  type MultiSpawnSideDraft,
} from "../utils/multiSpawn";
import { accessOptions } from "./composer/config";
import {
  formatDuoRecoveryCommand,
  recoveryCommandShell,
} from "../utils/duoRecoveryCommands";
import { ModelChooser } from "./ModelChooser";
import { IconButton, LoadingMark } from "./ui";

export interface MultiSpawnDialogProps {
  open: boolean;
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  submitting: boolean;
  cancelling?: boolean;
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
  index: 0 | 1 | 2;
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
  const isJudge = index === 2;
  const chatLabel = isJudge ? "Comparison chat" : `Chat ${index + 1}`;

  return (
    <section
      className="multi-spawn-side"
      data-route-side={index === 0 ? "a" : index === 1 ? "b" : "judge"}
      aria-labelledby={`multi-spawn-side-heading-${index}`}
    >
      <header>
        <span className="multi-spawn-side-number">
          {isJudge ? <Scale size={13} /> : index + 1}
        </span>
        <span>
          <strong id={`multi-spawn-side-heading-${index}`}>
            {index === 0 ? "Route A" : index === 1 ? "Route B" : "Judge route"}
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
            aria-label={`${chatLabel} name`}
            value={side.title}
            maxLength={120}
            disabled={disabled}
            placeholder={index === 0
              ? "Implementation review"
              : index === 1
                ? "Second opinion"
                : "Independent comparison"}
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
            aria-label={`${chatLabel} project`}
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
          <span><ShieldCheck size={11} /> Access</span>
          <select
            id={accessId}
            aria-label={`${chatLabel} access`}
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
  cancelling = false,
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
  onOpenProviderSetup,
  onOpenBackendSetup,
}: MultiSpawnDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const initializedForOpenRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const [draft, setDraft] = useState<MultiSpawnDraft | null>(null);
  const [copiedRecoveryCommand, setCopiedRecoveryCommand] = useState<
    string | null
  >(null);
  useNativePreviewSuspension(open);
  const busy = submitting
    || cancelling
    || acknowledgingRecovery
    || retryingComparison
    || cancellingComparison;
  const copyRecoveryCommand = async (
    key: string,
    commandText: string,
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(commandText);
      setCopiedRecoveryCommand(key);
    } catch {
      setCopiedRecoveryCommand(null);
    }
  };

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
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
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
      if (restoreFocusRef.current && previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Own Escape before an underlying mobile sidebar can dismiss itself
        // and unmount the trigger that should receive restored focus.
        event.stopImmediatePropagation();
        event.preventDefault();
        if (!cancelling) onClose();
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
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelling, onClose, open]);

  if (!open || !snapshot || !draft) return null;

  const routeStateFor = (side: MultiSpawnSideDraft): RouteState => {
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
  };
  const routeStates: [RouteState, RouteState] = [
    routeStateFor(draft.sides[0]),
    routeStateFor(draft.sides[1]),
  ];
  const comparisonRouteState = routeStateFor(draft.comparison.side);
  const validationError = validateMultiSpawnDraft(draft);
  const routesReady = routeStates.every(({ ready }) => ready)
    && (!draft.comparison.enabled || comparisonRouteState.ready);
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
        if (event.target === event.currentTarget && !submitting && !cancelling) onClose();
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
            <Columns2 size={18} />
          </span>
          <span>
            <h2 id="multi-spawn-title">Launch a duo</h2>
            <p id="multi-spawn-description">
              Send one brief to two independent routes. Inertia coordinates
              the launch durably, but provider-side effects cannot be atomic.
            </p>
          </span>
          <IconButton
            label="Close multi-spawn"
            disabled={cancelling}
            onClick={onClose}
          >
            <X size={16} />
          </IconButton>
        </header>

        <div className="multi-spawn-prompt-zone">
          <label htmlFor="multi-spawn-prompt">
            <span>Brief for both chats</span>
            <small>{draft.prompt.trim().length.toLocaleString("en-US")} / 20,000</small>
          </label>
          <textarea
            ref={promptRef}
            id="multi-spawn-prompt"
            aria-label="Shared prompt"
            value={draft.prompt}
            maxLength={20_000}
            disabled={busy}
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
            disabled={busy}
            onChange={(next) => updateSide(0, next)}
            onRepair={() => openRepair(0)}
          />
          <span className="multi-spawn-pair-arrow" aria-hidden="true">
            <ArrowLeftRight size={15} />
          </span>
          <MultiSpawnSideEditor
            index={1}
            side={draft.sides[1]}
            projects={snapshot.projects}
            routeState={routeStates[1]}
            disabled={busy}
            onChange={(next) => updateSide(1, next)}
            onRepair={() => openRepair(1)}
          />
        </div>

        <section
          className={`multi-spawn-comparison${draft.comparison.enabled ? " is-enabled" : ""}`}
          aria-labelledby="multi-spawn-comparison-title"
        >
          <label className="multi-spawn-comparison-toggle">
            <input
              type="checkbox"
              aria-label="Compare with a third model"
              checked={draft.comparison.enabled}
              disabled={busy}
              onChange={(event) => setDraft({
                ...draft,
                comparison: {
                  ...draft.comparison,
                  enabled: event.currentTarget.checked,
                },
              })}
            />
            <span>
              <strong id="multi-spawn-comparison-title">
                Compare both results with a third model
              </strong>
              <small>
                After both routes finish, a separate judge receives their
                bounded results and opens as the full-width chat.
              </small>
            </span>
          </label>

          {draft.comparison.enabled && (
            <div className="multi-spawn-comparison-body">
              <MultiSpawnSideEditor
                index={2}
                side={draft.comparison.side}
                projects={snapshot.projects}
                routeState={comparisonRouteState}
                disabled={busy}
                onChange={updateComparison}
                onRepair={() => openRepair(2)}
              />
              {judgeSharesSourceCheckout && (
                <div className="multi-spawn-judge-risk" role="status">
                  <TriangleAlert size={15} />
                  <span>
                    <strong>Judge can edit a source checkout</strong>
                    The selected access is write-capable. The judge starts only
                    after both source turns end, but the lock does not make this
                    checkout read-only. Choose Supervised or another project if
                    comparison should not make autonomous edits.
                  </span>
                </div>
              )}
              <details className="multi-spawn-lock-contract">
                <summary>What is shared with the judge?</summary>
                <p>
                  Inertia waits for both pinned turns, then sends the shared
                  brief, each terminal status, and up to 5,500 characters of
                  each attributed assistant result. It sends no source session,
                  reasoning, tool history, permissions, credentials,
                  attachments, or hidden context.
                </p>
                <p>
                  The judge uses only the project, route, and access selected
                  above. The comparison does not freeze either source chat or
                  working tree.
                </p>
              </details>
            </div>
          )}
        </section>

        {sharesLocalCheckout && (
          <div className="multi-spawn-dialog-status" role="status">
            Both agents will share this project checkout. Concurrent edits can
            overlap; choose different projects or enable isolated worktrees in
            Settings when you need independent changes.
          </div>
        )}

        {(error || recoveryStatus || (!routesReady && !submitting)) && (
          <div
            className={`multi-spawn-dialog-status${error ? " is-error" : ""}`}
            role={error ? "alert" : "status"}
          >
            {error
              ?? (draft.comparison.enabled
                ? "Choose three ready routes before launching the Duo comparison."
                : "Choose two ready routes before launching the duo.")}
            {recoveryStatus && (
              <section
                className="multi-spawn-recovery-status"
                aria-label="Duo dispatch and recovery status"
              >
                <strong>
                  {recoveryStatus.state === "recovery-required"
                    ? "Recovery required"
                    : recoveryStatus.state === "interrupted"
                      ? "Dispatch outcome uncertain"
                      : recoveryStatus.sides.some(
                          ({ dispatchState }) => dispatchState === "started",
                        ) && recoveryStatus.sides.some(
                          ({ dispatchState }) => dispatchState === "failed",
                        )
                        ? "Partial provider dispatch"
                        : `Duo ${recoveryStatus.state}`}
                </strong>
                <p>
                  Local coordination is durable. A provider may have accepted
                  work before its sibling failed or the connection changed, so
                  Inertia will not claim those external effects were atomic.
                </p>
                <dl>
                  {recoveryStatus.sides.map((side) => (
                    <div key={side.ordinal}>
                      <dt>Route {side.ordinal + 1}</dt>
                      <dd>{({
                        pending: "Not dispatched",
                        claimed: "Dispatch claimed",
                        started: "Provider accepted start",
                        failed: "Provider start failed",
                        cancelled: "Dispatch cancelled",
                        uncertain: "Provider effect unknown",
                      } as const)[side.dispatchState]}</dd>
                    </div>
                  ))}
                </dl>
                {recoveryStatus.comparison && (
                  <section
                    className="multi-spawn-comparison-status"
                    aria-label="Third-model comparison status"
                  >
                    <span>
                      <Scale size={14} />
                      <strong>Separate third-model judge</strong>
                    </span>
                    <dl>
                      <div>
                        <dt>State</dt>
                        <dd>{({
                          waiting: "Locked · waiting for both source turns",
                          dispatching: "Durable judge dispatch claimed",
                          running: "Judge is comparing",
                          completed: "Comparison completed",
                          failed: "Judge failed · explicit retry available",
                          cancelled: "Comparison cancelled · lock released",
                          interrupted: "Judge outcome interrupted · not retried",
                        } as const)[recoveryStatus.comparison.state]}</dd>
                      </div>
                      <div>
                        <dt>Judge chat</dt>
                        <dd><code>{recoveryStatus.comparison.conversationId ?? "Not created"}</code></dd>
                      </div>
                      <div>
                        <dt>Attempts</dt>
                        <dd>{recoveryStatus.comparison.attempt}</dd>
                      </div>
                    </dl>
                    {recoveryStatus.comparison.error && (
                      <p>{recoveryStatus.comparison.error}</p>
                    )}
                    <div>
                      {(recoveryStatus.comparison.state === "failed"
                        || recoveryStatus.comparison.state === "interrupted")
                        && onRetryComparison && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => { void onRetryComparison(); }}
                        >
                          {retryingComparison ? "Retrying judge…" : "Retry judge explicitly"}
                        </button>
                      )}
                      {recoveryStatus.comparison.state !== "completed"
                        && recoveryStatus.comparison.state !== "cancelled"
                        && onCancelComparison && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => { void onCancelComparison(); }}
                        >
                          {cancellingComparison
                            ? "Cancelling comparison…"
                            : "Cancel comparison and release lock"}
                        </button>
                      )}
                    </div>
                  </section>
                )}
                {onRecheckRecovery && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || recheckingRecovery}
                    onClick={() => { void onRecheckRecovery(); }}
                  >
                    {recheckingRecovery ? "Re-checking…" : "Re-check recovery status"}
                  </button>
                )}
                {recoveryStatus.state === "interrupted"
                  && onAcknowledgeRecovery && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || recheckingRecovery}
                    onClick={() => { void onAcknowledgeRecovery(); }}
                  >
                    {acknowledgingRecovery
                      ? "Acknowledging…"
                      : "I inspected both chats — continue"}
                  </button>
                )}
              </section>
            )}
            {recoveryGuidance.map((guidance) => (
              <section
                key={`${guidance.launchId}:${guidance.ordinal}:${guidance.worktreeId ?? "unknown"}`}
                className="multi-spawn-recovery-guidance"
                aria-label={`Manual Git recovery for route ${guidance.ordinal + 1}`}
              >
                <p>
                  Inspect this exact topology before making a manual change.
                  Commands are offered only for an exact owned worktree or a
                  retained generated branch; ambiguous and conflicting state
                  remains read-only.
                </p>
                <dl>
                  <dt>Repository</dt>
                  <dd><code>{guidance.repositoryPath}</code></dd>
                  <dt>Planned path</dt>
                  <dd><code>{guidance.plannedPath}</code></dd>
                  <dt>Registered path</dt>
                  <dd><code>{guidance.observedPath ?? "Not verified"}</code></dd>
                  <dt>Worktree ID</dt>
                  <dd><code>{guidance.worktreeId ?? "Not verified"}</code></dd>
                  <dt>Topology</dt>
                  <dd><code>{guidance.topology}</code></dd>
                  <dt>Generated branch</dt>
                  <dd><code>{guidance.generatedBranch}</code></dd>
                  <dt>Expected commit</dt>
                  <dd><code>{guidance.expectedHead ?? "Not verified"}</code></dd>
                  <dt>Observed branch</dt>
                  <dd><code>{guidance.observedBranch ?? "Not verified"}</code></dd>
                  <dt>Observed commit</dt>
                  <dd><code>{guidance.observedHead ?? "Not verified"}</code></dd>
                </dl>
                {guidance.actions.length > 0 && (
                  <ol>
                    {guidance.actions.map((action) => {
                      const key = `${action.label}:${action.args.join("\0")}`;
                      const shell = recoveryCommandShell(action);
                      const commandText = formatDuoRecoveryCommand(action, shell);
                      return (
                      <li key={key}>
                        <strong>{action.label}</strong>
                        <span>{shell === "powershell" ? "PowerShell" : "POSIX shell"}</span>
                        <code data-recovery-command>{commandText}</code>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            void copyRecoveryCommand(key, commandText);
                          }}
                        >
                          {copiedRecoveryCommand === key
                            ? "Copied"
                            : `Copy ${action.label.toLocaleLowerCase("en-US")} command`}
                        </button>
                      </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ))}
          </div>
        )}

        <footer className="multi-spawn-dialog-footer">
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
              <strong>Save this pairing</strong>
              <small>
                Saves names, routes, reasoning, access, and the compare toggle
                locally — never prompts or projects.
              </small>
            </span>
          </label>
          <div>
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
              disabled={busy || Boolean(validationError) || !routesReady}
              title={validationError ?? (!routesReady
                ? (draft.comparison.enabled
                    ? "All three routes must be ready."
                    : "Both routes must be ready.")
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
