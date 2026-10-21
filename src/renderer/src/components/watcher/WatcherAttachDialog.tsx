import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import type {
  AppSettings,
  AppSnapshot,
  ModelSelection,
  ProviderId,
  ServerEvent,
} from "@shared/contracts";
import { providerIdForHarness } from "@shared/model-routing";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";
import {
  clampWatcherBudgets,
  DEFAULT_WATCHER_BUDGETS,
  DEFAULT_WATCHER_SHARING,
  MAX_WATCHER_INSTRUCTIONS_CHARS,
  WATCHER_BUDGET_LIMITS,
  WATCHER_PRESET_LABELS,
  WATCHER_PRESETS,
  watcherHarnessAllowed,
  type WatcherBudgets,
  type WatcherDeliveryPolicy,
  type WatcherLinkView,
  type WatcherPreset,
  type WatcherPrivateConnect,
  type WatcherSharing,
} from "@shared/watcher";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { usePrivateConnectConfigured } from "../../hooks/usePrivateConnectState";
import { useRovingRadios } from "../../hooks/useRovingRadios";
import { resultEvent, type CommandWithoutId } from "../../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../../utils/connectionMessages";
import { watcherErrorText } from "../../utils/watcherCopy";
import {
  composerRouteReadiness,
  type ComposerRouteRepair,
} from "../../utils/composerReadiness";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../../utils/modelChooserRoutes";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { DialogPresence } from "../DialogPresence";
import { DialogShell } from "../DialogShell";
import { ModelChooser } from "../ModelChooser";
import { LoadingMark, Switch } from "../ui";
import type { WatcherAttachTarget } from "../../hooks/useWatcherSurface";
import "./WatcherAttachDialog.css";

interface WatcherAttachDialogProps {
  snapshot: AppSnapshot;
  settings: AppSettings;
  watchedConversationId: string;
  returnFocusTo?: HTMLElement | null;
  closing?: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onClose: () => void;
  onAttached: (link: WatcherLinkView) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
}

export interface WatcherAttachHostProps {
  target: WatcherAttachTarget | null;
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onClose: () => void;
  onAttached: (link: WatcherLinkView) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
}

const WATCHER_READ_ONLY_STATEMENT = "It reads and reports: it may run read-only commands and never edits files or changes the workspace.";
const ATTACH_FAILED = "The watcher could not be attached.";

const SHARING_FIELDS: ReadonlyArray<{ key: keyof WatcherSharing; label: string }> = [
  { key: "brief", label: "The brief" },
  { key: "activities", label: "Activities" },
  { key: "changedFiles", label: "Changed files" },
  { key: "partialReplies", label: "Partial replies" },
];

const BUDGET_FIELDS: ReadonlyArray<{ key: keyof WatcherBudgets; label: string; unit: string }> = [
  { key: "wakesPerWatchedTurn", label: "Checks per turn", unit: "" },
  { key: "cooldownSeconds", label: "Cooldown between checks", unit: "s" },
  { key: "digestKiB", label: "Digest size", unit: "KiB" },
  { key: "contextReadsPerWake", label: "Context reads per check", unit: "" },
];

function stripInstructionControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

interface RouteChoice {
  route: ComposerModelRoute;
  ready: boolean;
  repair: ComposerRouteRepair | null;
  title: string;
  detail: string;
}

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: { ...selection.providerOptions },
    capabilities: selection.capabilities.map((capability) => ({ ...capability })),
  };
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.harnessId === right.harnessId
    && left.backendProfileId === right.backendProfileId
    && left.modelId === right.modelId
    && left.backendConfigurationRevision === right.backendConfigurationRevision;
}

function routeChoices(
  snapshot: AppSnapshot,
  selection: ModelSelection,
  labels: AppSettings["providerIdentityLabels"],
): RouteChoice[] {
  return buildComposerModelRoutes(snapshot.providers, snapshot.backendProfiles ?? [], selection, labels)
    .filter((route) => watcherHarnessAllowed(route.harnessId))
    .map((route) => {
      const providerId = providerIdForHarness(route.harnessId);
      const readiness = composerRouteReadiness({
        provider: snapshot.providers.find(({ id }) => id === providerId),
        profile: snapshot.backendProfiles?.find(({ id }) => id === route.backendProfileId),
        selection: route.selection,
      });
      const ready = route.selectable && readiness.ready;
      return {
        route: ready
          ? route
          : { ...route, selectable: false, unavailableReason: readiness.ready ? route.unavailableReason : readiness.detail },
        ready,
        repair: readiness.ready ? null : readiness.action,
        title: readiness.ready ? "Model route unavailable" : readiness.title,
        detail: readiness.ready
          ? route.unavailableReason ?? "Choose a ready route."
          : readiness.detail,
      };
    });
}

function initialSelection(
  snapshot: AppSnapshot,
  watched: AppSnapshot["conversations"][number] | null,
  labels: AppSettings["providerIdentityLabels"],
): ModelSelection | null {
  const fallback = watched?.modelSelection ?? null;
  const candidates = fallback ? routeChoices(snapshot, fallback, labels) : [];
  const own = fallback
    ? candidates.find((choice) => choice.ready && sameSelection(choice.route.selection, fallback))
    : undefined;
  const ready = own ?? candidates.find((choice) => choice.ready) ?? candidates[0];
  return ready ? cloneSelection(ready.route.selection) : fallback;
}

function WatcherBudgetFields({
  drafts,
  budgets,
  disabled,
  onDraftsChange,
}: {
  drafts: Record<keyof WatcherBudgets, string>;
  budgets: WatcherBudgets;
  disabled: boolean;
  onDraftsChange: (update: (current: Record<keyof WatcherBudgets, string>) => Record<keyof WatcherBudgets, string>) => void;
}): React.JSX.Element {
  return (
    <div className="watcher-attach-budgets">
      {BUDGET_FIELDS.map(({ key, label, unit }) => {
        const limits = WATCHER_BUDGET_LIMITS[key];
        return (
          <label key={key} className="watcher-attach-budget">
            <span>{label}</span>
            <span className="watcher-attach-budget-input">
              <input
                type="number"
                inputMode="numeric"
                min={limits.min}
                max={limits.max}
                step={1}
                value={drafts[key]}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onDraftsChange((current) => ({ ...current, [key]: value }));
                }}
                onBlur={() => onDraftsChange((current) => ({ ...current, [key]: String(budgets[key]) }))}
              />
              {unit && <span aria-hidden="true">{unit}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function WatcherAttachDialog({
  snapshot,
  settings,
  watchedConversationId,
  returnFocusTo = null,
  closing = false,
  request,
  onClose,
  onAttached,
  onOpenProviderSetup,
  onOpenBackendSetup,
}: WatcherAttachDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(true);
  const returnFocusRef = useRef(returnFocusTo);
  const watched = snapshot.conversations.find(({ id }) => id === watchedConversationId) ?? null;
  const labels = settings.providerIdentityLabels;
  const [selection, setSelection] = useState<ModelSelection | null>(() => initialSelection(snapshot, watched, labels));
  const [preset, setPreset] = useState<WatcherPreset>("reviewer");
  const [instructions, setInstructions] = useState("");
  const [sharing, setSharing] = useState<WatcherSharing>({ ...DEFAULT_WATCHER_SHARING });
  const [budgetDrafts, setBudgetDrafts] = useState<Record<keyof WatcherBudgets, string>>(() => ({
    wakesPerWatchedTurn: String(DEFAULT_WATCHER_BUDGETS.wakesPerWatchedTurn),
    cooldownSeconds: String(DEFAULT_WATCHER_BUDGETS.cooldownSeconds),
    digestKiB: String(DEFAULT_WATCHER_BUDGETS.digestKiB),
    contextReadsPerWake: String(DEFAULT_WATCHER_BUDGETS.contextReadsPerWake),
  }));
  const [privateConnect, setPrivateConnect] = useState<WatcherPrivateConnect>("inherit");
  const [delivery, setDelivery] = useState<WatcherDeliveryPolicy>("manual");
  const [initialReview, setInitialReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const privateConnectConfigured = usePrivateConnectConfigured();
  const linkIdRef = useRef<string | null>(null);
  const attachedRef = useRef(false);
  const presets = useRovingRadios(WATCHER_PRESETS, preset, setPreset);
  useNativePreviewSuspension(true);

  const choices = useMemo(
    () => selection ? routeChoices(snapshot, selection, labels) : [],
    [labels, selection, snapshot],
  );
  const selectedChoice = selection
    ? choices.find((choice) => sameSelection(choice.route.selection, selection)) ?? null
    : null;
  const routeReady = selectedChoice?.ready === true;
  const selectedRoute = selection
    ? selectedModelSearchRoute(choices.map(({ route }) => route), selection)
    : null;
  const budgets = clampWatcherBudgets(Object.fromEntries(
    BUDGET_FIELDS.map(({ key }) => [key, budgetDrafts[key].trim() === "" ? undefined : Number(budgetDrafts[key])]),
  ) as Partial<Record<keyof WatcherBudgets, number>>);
  const latestStatus = watched?.latestTurn?.status;
  const hasReviewableTurn = latestStatus === "completed"
    || (latestStatus !== undefined && !isAgentTurnTerminalStatus(latestStatus));
  const canAttach = Boolean(watched && selection && routeReady && !submitting
    && instructions.length <= MAX_WATCHER_INSTRUCTIONS_CHARS);

  useEffect(() => {
    restoreFocusRef.current = true;
    const restoreFocus = captureModalFocus();
    const fallback = returnFocusRef.current;
    const frame = window.requestAnimationFrame(() => {
      const checked = dialogRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      checked?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (!restoreFocusRef.current) return;
      if (fallback?.isConnected) fallback.focus({ preventScroll: true });
      else restoreFocus();
    };
  }, []);

  const attachedLink = linkIdRef.current
    ? snapshot.watchers?.find(({ id, status }) => id === linkIdRef.current && status !== "detached") ?? null
    : null;
  useEffect(() => {
    if (!attachedLink || attachedRef.current) return;
    attachedRef.current = true;
    restoreFocusRef.current = false;
    onAttached(attachedLink);
  }, [attachedLink, onAttached]);

  useEffect(() => {
    if (closing) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        const nested = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
        if (nested && nested !== dialogRef.current && dialogRef.current?.contains(nested)) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (!submitting) onClose();
        return;
      }
      if (dialogRef.current) trapModalFocus(event, dialogRef.current);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [closing, onClose, submitting]);

  const watchedGone = !watched;
  useEffect(() => {
    if (watchedGone) onClose();
  }, [onClose, watchedGone]);

  if (!watched) return null;

  const openRepair = (): void => {
    const choice = selectedChoice;
    if (!choice?.repair) return;
    restoreFocusRef.current = false;
    onClose();
    if (choice.repair === "add-key" || choice.repair === "configure" || choice.repair === "probe") {
      onOpenBackendSetup(choice.route.backendProfileId);
      return;
    }
    const providerId = choice.route.providerId;
    if (providerId) onOpenProviderSetup(providerId);
  };

  const attach = (): void => {
    if (!canAttach || !selection) return;
    setSubmitting(true);
    setError(null);
    const linkId = linkIdRef.current ?? crypto.randomUUID();
    linkIdRef.current = linkId;
    void request({
      type: "watcher.attach",
      payload: {
        linkId,
        watchedConversationId,
        modelSelection: {
          ...selection,
          providerOptions: { ...selection.providerOptions },
          capabilities: selection.capabilities.map((capability) => ({ ...capability })),
        },
        preset,
        instructions: instructions.trim(),
        sharing,
        budgets,
        privateConnect,
        delivery,
        initialReview: initialReview && hasReviewableTurn,
      },
    }).then((event) => {
      const { result } = resultEvent(event);
      if (result.kind !== "watcher.link") throw new Error(ATTACH_FAILED);
      if (attachedRef.current) return;
      attachedRef.current = true;
      restoreFocusRef.current = false;
      onAttached(result.link);
    }).catch((failure: unknown) => {
      if (attachedRef.current) return;
      if (runtimeCommandDelivery(failure) !== "ambiguous") linkIdRef.current = null;
      setError(watcherErrorText(failure, ATTACH_FAILED));
      setSubmitting(false);
      attachRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <DialogShell
      ref={dialogRef}
      className="watcher-attach-dialog"
      bodyClassName="watcher-attach-body"
      titleId="watcher-attach-title"
      title="Add a watcher"
      description={WATCHER_READ_ONLY_STATEMENT}
      closeLabel="Close"
      closeInert={submitting}
      onClose={onClose}
      onDismiss={() => { if (!submitting) onClose(); }}
      trapFocus={false}
      footer={<>
        <button
          type="button"
          className="secondary-button"
          aria-disabled={submitting || undefined}
          onClick={() => { if (!submitting) onClose(); }}
        >
          Cancel
        </button>
        <button
          ref={attachRef}
          type="button"
          className="primary-button"
          aria-disabled={!canAttach || undefined}
          title={routeReady ? undefined : "Choose a ready route."}
          onClick={attach}
        >
          {submitting && <LoadingMark label="Adding watcher" />}
          {submitting ? "Adding…" : "Add watcher"}
        </button>
      </>}
    >
      <section className="watcher-attach-section" aria-labelledby="watcher-attach-preset-label">
        <h3 id="watcher-attach-preset-label">Preset</h3>
        <div
          className="watcher-attach-presets"
          role="radiogroup"
          aria-labelledby="watcher-attach-preset-label"
          {...presets.groupProps}
        >
          {WATCHER_PRESETS.map((option) => (
            <button
              key={option}
              type="button"
              className="watcher-attach-preset"
              disabled={submitting}
              {...presets.radioProps(option)}
            >
              {WATCHER_PRESET_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="watcher-attach-section" aria-labelledby="watcher-attach-route-label">
        <h3 id="watcher-attach-route-label">Model route</h3>
        {selectedRoute ? (
          <ModelChooser
            routes={choices.map(({ route }) => route)}
            selectedRoute={selectedRoute}
            disabled={submitting}
            onSelect={(route) => {
              if (route.selectable) setSelection(cloneSelection(route.selection));
            }}
          />
        ) : null}
        {!routeReady && (
          <div className="watcher-attach-warning" role="status">
            <span>
              <strong>{choices.length === 0 ? "No watcher route" : selectedChoice?.title ?? "Model route unavailable"}</strong>
              <span>
                {choices.length === 0
                  ? "Check Settings → Agents."
                  : selectedChoice?.detail ?? "Choose a ready route."}
              </span>
            </span>
            {selectedChoice?.repair && (
              <button type="button" className="secondary-button" onClick={openRepair}>Open setup</button>
            )}
          </div>
        )}
      </section>

      <section className="watcher-attach-section">
        <label className="watcher-attach-label" htmlFor="watcher-attach-instructions">
          <span>Your instructions <small>(optional)</small></span>
          <small aria-hidden="true">
            {instructions.length.toLocaleString(INTERFACE_LOCALE)} / {MAX_WATCHER_INSTRUCTIONS_CHARS.toLocaleString(INTERFACE_LOCALE)}
          </small>
        </label>
        <textarea
          id="watcher-attach-instructions"
          value={instructions}
          maxLength={MAX_WATCHER_INSTRUCTIONS_CHARS}
          disabled={submitting}
          placeholder="For example: watch for changes to the public API."
          onChange={(event) => setInstructions(stripInstructionControls(event.currentTarget.value))}
        />
      </section>

      <fieldset className="watcher-attach-section watcher-attach-sharing" disabled={submitting}>
        <legend>What the watcher sees</legend>
        {SHARING_FIELDS.map(({ key, label }) => (
          <label key={key} className="watcher-attach-check">
            <input
              type="checkbox"
              checked={sharing[key]}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSharing((current) => ({ ...current, [key]: checked }));
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      <section className="watcher-attach-section watcher-attach-toggle">
        <Switch
          id="watcher-attach-auto-send"
          checked={delivery === "auto"}
          disabled={submitting}
          onChange={(checked) => setDelivery(checked ? "auto" : "manual")}
        />
        <label htmlFor="watcher-attach-auto-send">Send findings to the main chat automatically</label>
      </section>

      <section className="watcher-attach-section watcher-attach-toggle">
        <Switch
          id="watcher-attach-initial-review"
          checked={initialReview && hasReviewableTurn}
          disabled={submitting || !hasReviewableTurn}
          onChange={setInitialReview}
        />
        <label htmlFor="watcher-attach-initial-review">Review the last turn now</label>
      </section>

      {privateConnectConfigured && (
        <fieldset className="watcher-attach-section watcher-attach-visibility" disabled={submitting}>
          <legend>On paired devices</legend>
          <label className="watcher-attach-check">
            <input type="radio" name="watcher-attach-visibility" checked={privateConnect === "inherit"} onChange={() => setPrivateConnect("inherit")} />
            <span>Follow this chat's visibility</span>
          </label>
          <label className="watcher-attach-check">
            <input type="radio" name="watcher-attach-visibility" checked={privateConnect === "hidden"} onChange={() => setPrivateConnect("hidden")} />
            <span>Hidden</span>
          </label>
        </fieldset>
      )}

      <details className="watcher-attach-section watcher-attach-disclosure">
        <summary>
          Budgets
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <WatcherBudgetFields drafts={budgetDrafts} budgets={budgets} disabled={submitting} onDraftsChange={setBudgetDrafts} />
      </details>

      {error && <p className="watcher-attach-error" role="alert">{error}</p>}
    </DialogShell>
  );
}

export function WatcherAttachPresence({ target, snapshot, ...props }: WatcherAttachHostProps): React.JSX.Element | null {
  const lastTarget = useRef(target);
  if (target) lastTarget.current = target;
  const shown = lastTarget.current;
  if (!snapshot || !shown) return null;
  return (
    <DialogPresence open={target !== null}>
      <WatcherAttachDialog
        key={shown.watchedId}
        snapshot={snapshot}
        watchedConversationId={shown.watchedId}
        returnFocusTo={shown.returnFocusTo}
        closing={target === null}
        {...props}
      />
    </DialogPresence>
  );
}
