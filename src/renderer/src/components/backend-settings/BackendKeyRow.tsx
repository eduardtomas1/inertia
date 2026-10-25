import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, KeyRound, Pencil, Power, Trash2, Zap } from "lucide-react";
import clsx from "clsx";

import { backendCredentialSecretIssue } from "@shared/backend-credentials";
import type {
  ModelBackendProfileDetail,
  ModelBackendProfileView,
} from "@shared/contracts";
import {
  backendCredentialRequired,
  backendKeyCheckProblem,
  backendEndpointLabel,
  backendKeyState,
  backendProbePassed,
  modelProbeOutcome,
} from "../../utils/backendSettingsModel";
import { LoadingMark } from "../ui";
import { BackendProfileEditor } from "./BackendProfileForms";
import { BackendStateBadge } from "./ProviderAccountRow";
import { promptCacheSummary } from "./PromptCacheChoice";
import { promptCacheTtlAllowed } from "@shared/compact-on-return";
import type { BackendSetupStatus, BackendSetupStatusListener } from "./useBackendSetup";
import {
  failureMessage,
  probeEveryModel,
  probeProgressLabel,
  type BackendProfileActions,
  type ProbeProgress,
} from "./backendSettingsActions";

type Panel = "key" | "test" | "edit" | "remove";

function latestProbeTime(models: ModelBackendProfileView["models"]): number {
  return Math.max(0, ...models.map(({ latestProbe }) => latestProbe ? Date.parse(latestProbe.checkedAt) : 0));
}
type Busy = "key" | "forget" | "test" | "toggle" | "delete" | "load";

interface KeyDraft {
  revision: number;
  value: string;
}

export function BackendKeyRow({
  profile,
  actions,
  disabled,
  initiallyOpenKey = false,
  initiallyOpenModels = false,
  setupStatus = null,
  onSetupStatus,
  onResumeSetup,
}: {
  profile: ModelBackendProfileView;
  actions: BackendProfileActions;
  disabled: boolean;
  initiallyOpenKey?: boolean;
  initiallyOpenModels?: boolean;
  setupStatus?: BackendSetupStatus | null;
  onSetupStatus?: BackendSetupStatusListener;
  onResumeSetup?: () => void;
}): React.JSX.Element {
  const nameId = useId();
  const stateId = useId();
  const keyInputId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();
  const [panel, setPanel] = useState<Panel | null>(
    initiallyOpenKey && profile.authenticationMode !== "none" ? "key" : null,
  );
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<KeyDraft | null>(null);
  const [keySubmitted, setKeySubmitted] = useState(false);
  const [detail, setDetail] = useState<ModelBackendProfileDetail | null>(null);
  const [tested, setTested] = useState<ModelBackendProfileDetail | null>(null);
  const [progress, setProgress] = useState<ProbeProgress | null>(null);
  const mountedRef = useRef(true);
  const keyButtonRef = useRef<HTMLButtonElement>(null);
  const testButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<React.RefObject<HTMLButtonElement | null> | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    setKeyDraft((current) => current && current.revision !== profile.configurationRevision ? null : current);
  }, [profile.configurationRevision]);
  useLayoutEffect(() => {
    if (panel === "key") keyInputRef.current?.focus();
    else if (panel === "remove") removeCancelRef.current?.focus();
    else if (panel === null && restoreFocusRef.current) {
      restoreFocusRef.current.current?.focus();
      restoreFocusRef.current = null;
    }
  }, [panel]);

  const name = profile.displayName;
  const configured = profile.authState === "configured";
  const credentialRequired = backendCredentialRequired(profile);
  const needsKey = profile.authenticationMode !== "none" || credentialRequired;
  const keyVerb = configured ? "Replace key" : "Add key";
  const credentialNoun = profile.authenticationMode === "bearer-token" ? "token" : "API key";
  const secret = keyDraft?.revision === profile.configurationRevision ? keyDraft.value : "";
  const keyIssue = backendCredentialSecretIssue(secret);
  const state = setupStatus?.state === "running"
    ? { tone: "checking" as const, label: "Setting up…" }
    : setupStatus?.state === "failed"
      ? { tone: "unavailable" as const, label: `Failed: ${setupStatus.message}` }
      : setupStatus?.state === "paused"
        ? { tone: "attention" as const, label: setupStatus.message }
      : backendKeyState(profile, busy === "test" || busy === "key");
  const results = tested
    && tested.configurationRevision >= profile.configurationRevision
    && latestProbeTime(tested.models) >= latestProbeTime(profile.models)
    ? tested.models
    : profile.models;
  const inactive = disabled || busy !== null;

  const closePanel = (focus: React.RefObject<HTMLButtonElement | null>): void => {
    restoreFocusRef.current = focus;
    setPanel(null);
    setKeySubmitted(false);
  };
  const openPanel = (next: Panel): void => {
    setError(null);
    setPanel((current) => current === next ? null : next);
  };
  const run = async (
    key: Busy,
    operation: () => Promise<void>,
    fallback: string,
  ): Promise<void> => {
    if (busy || disabled) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (mountedRef.current) setError(failureMessage(reason, fallback));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };
  const openEditor = (): void => {
    void run("load", async () => {
      const value = await actions.onLoadDetail(profile.id);
      if (!mountedRef.current) return;
      setDetail(value);
      setPanel("edit");
    }, "The route details could not be loaded.");
  };
  const openModelsOnMountRef = useRef(initiallyOpenModels);
  useEffect(() => {
    if (!openModelsOnMountRef.current) return;
    openModelsOnMountRef.current = false;
    openEditor();
  });
  const testAll = async (turnBackOn: boolean): Promise<ModelBackendProfileDetail> => {
    let result = await probeEveryModel(actions.onProbe, profile, (counts) => {
      if (mountedRef.current) setProgress(counts);
    });
    if (mountedRef.current) setTested(result);
    if (turnBackOn && !result.enabled && backendProbePassed(result) && profile.canDisable) {
      result = await actions.onUpdate(profile.id, { enabled: true });
    }
    return result;
  };
  const saveKey = (): void => {
    if (configured && secret.trim() === "") {
      setKeyDraft(null);
      closePanel(keyButtonRef);
      return;
    }
    setKeySubmitted(true);
    if (keyIssue) {
      keyInputRef.current?.focus();
      return;
    }
    const value = secret.trim();
    const completesSetup = profile.enabled || profile.authState === "missing" || credentialRequired;
    void run("key", async () => {
      if (profile.authenticationMode === "none") {
        await actions.onUpdate(profile.id, { authenticationMode: "api-key" });
      }
      await actions.onSetCredential(profile.id, value);
      if (!mountedRef.current) return;
      setKeyDraft(null);
      setKeySubmitted(false);
      setPanel("test");
      keyButtonRef.current?.focus();
      await testAll(completesSetup);
      if (setupStatus) onSetupStatus?.(profile, { state: "done" });
    }, "The key could not be saved.");
  };

  return (
    <li className={clsx("backend-key-row", panel && "is-open")} aria-labelledby={nameId} data-profile-id={profile.id}>
      <div className="backend-key-row-summary">
        <span className="backend-key-row-copy">
          <strong id={nameId}>{name}</strong>
          <small>
            {backendEndpointLabel(profile)} · {profile.models.length} {profile.models.length === 1 ? "model" : "models"}
            {promptCacheTtlAllowed(profile) && ` · ${promptCacheSummary(profile.promptCacheTtl)}`}
          </small>
        </span>
        <BackendStateBadge state={state} id={stateId} />
      </div>
      <div className="backend-key-row-actions" role="group" aria-label={`${name} actions`}>
        {setupStatus?.state === "paused" && onResumeSetup && (
          <button
            type="button"
            className="secondary-button"
            aria-label={`Choose models for ${name}`}
            aria-disabled={inactive || undefined}
            onClick={() => { if (!inactive) onResumeSetup(); }}
          >
            Choose models
          </button>
        )}
        {setupStatus?.state === "failed" && (
          <button
            type="button"
            className="secondary-button"
            aria-label={`Try again for ${name}`}
            aria-disabled={inactive || undefined}
            onClick={() => {
              if (inactive) return;
              if (needsKey && !configured) {
                openPanel("key");
                return;
              }
              void run("test", async () => {
                onSetupStatus?.(profile, { state: "running" });
                try {
                  const checked = await actions.onProbe(profile.id, []);
                  const problem = backendKeyCheckProblem(checked);
                  if (problem) {
                    onSetupStatus?.(profile, { state: "failed", message: problem });
                    return;
                  }
                  if (!checked.enabled && profile.canDisable) await actions.onUpdate(profile.id, { enabled: true });
                  onSetupStatus?.(profile, { state: "done" });
                } catch (reason) {
                  onSetupStatus?.(profile, { state: "failed", message: failureMessage(reason, "The key could not be checked.") });
                }
              }, "The key could not be checked.");
            }}
          >
            Try again
          </button>
        )}
        {needsKey && (
          <button
            ref={keyButtonRef}
            type="button"
            className="secondary-button"
            aria-label={`${keyVerb} for ${name}`}
            aria-expanded={panel === "key"}
            aria-disabled={inactive || undefined}
            onClick={() => { if (!inactive) openPanel("key"); }}
          >
            <KeyRound size={14} aria-hidden="true" />{keyVerb}
          </button>
        )}
        <button
          ref={testButtonRef}
          type="button"
          className="secondary-button"
          aria-label={`Test ${name} (uses a little credit)`}
          aria-describedby={stateId}
          aria-disabled={inactive || (needsKey && !configured) || undefined}
          title={needsKey && !configured ? "Add a key first." : undefined}
          onClick={() => {
            if (inactive || (needsKey && !configured)) return;
            setPanel("test");
            void run("test", async () => { await testAll(profile.enabled); }, "The connection test could not run.");
          }}
        >
          {busy === "test" ? <LoadingMark size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
          {busy === "test" ? "Testing…" : "Test (uses a little credit)"}
        </button>
        <button
          ref={editButtonRef}
          type="button"
          className="secondary-button"
          aria-label={`${profile.preset === "custom" ? "Edit" : "Models for"} ${name}`}
          aria-expanded={panel === "edit"}
          aria-disabled={inactive || undefined}
          onClick={() => {
            if (inactive) return;
            if (panel === "edit") {
              closePanel(editButtonRef);
              return;
            }
            openEditor();
          }}
        >
          <Pencil size={14} aria-hidden="true" />{profile.preset === "custom" ? "Edit…" : "Models…"}
        </button>
        {profile.canDisable && (
          <button
            type="button"
            className="secondary-button"
            aria-label={`${profile.enabled ? "Turn off" : "Turn on"} ${name}`}
            aria-disabled={inactive || undefined}
            onClick={() => {
              void run("toggle", async () => {
                await actions.onUpdate(profile.id, { enabled: !profile.enabled });
              }, profile.enabled ? "The route could not be turned off." : "The route could not be turned on.");
            }}
          >
            <Power size={14} aria-hidden="true" />{profile.enabled ? "Turn off" : "Turn on"}
          </button>
        )}
        {profile.canDelete && (
          <button
            ref={removeButtonRef}
            type="button"
            className="secondary-button"
            aria-label={`Remove ${name}`}
            aria-expanded={panel === "remove"}
            aria-disabled={inactive || undefined}
            onClick={() => { if (!inactive) openPanel("remove"); }}
          >
            <Trash2 size={14} aria-hidden="true" />Remove
          </button>
        )}
      </div>

      {panel === "key" && (
        <form
          className="backend-key-panel"
          aria-label={`${keyVerb} for ${name}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            saveKey();
          }}
        >
          <div className="backend-field">
            <label htmlFor={keyInputId}>{configured ? `New ${credentialNoun}` : credentialNoun === "token" ? "Token" : "API key"}</label>
            <input
              ref={keyInputRef}
              id={keyInputId}
              className="setting-input"
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              placeholder={configured ? "Stored secret, enter a new value to replace" : undefined}
              disabled={busy === "key"}
              aria-invalid={keySubmitted && keyIssue ? true : undefined}
              aria-describedby={keySubmitted && keyIssue ? `${keyErrorId} ${keyHintId}` : keyHintId}
              onChange={(event) => setKeyDraft({
                revision: profile.configurationRevision,
                value: event.currentTarget.value,
              })}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setKeyDraft(null);
                closePanel(keyButtonRef);
              }}
            />
            {keySubmitted && keyIssue && <span id={keyErrorId} className="backend-field-error">{keyIssue}</span>}
            <small id={keyHintId} className="backend-field-hint">
              {configured
                ? "Replacing the key keeps this route, its chats and its models. Inertia tests the new key right away."
                : "The key is stored in your system's credential vault. Inertia tests it right away."}
            </small>
          </div>
          <div className="backend-panel-actions">
            {configured && (
              <button
                type="button"
                className="secondary-button"
                aria-disabled={inactive || undefined}
                onClick={() => {
                  void run("forget", async () => {
                    await actions.onClearCredential(profile.id);
                    if (!mountedRef.current) return;
                    setKeyDraft(null);
                    closePanel(keyButtonRef);
                  }, "The key could not be removed.");
                }}
              >
                Forget key
              </button>
            )}
            <button type="button" className="secondary-button" onClick={() => {
              setKeyDraft(null);
              closePanel(keyButtonRef);
            }}>Cancel</button>
            <button type="submit" className="primary-button" aria-disabled={inactive || undefined}>
              {busy === "key" ? "Saving…" : "Save key"}
            </button>
          </div>
        </form>
      )}

      {panel === "test" && (
        <div className="backend-test-panel">
          {busy === "test" && progress && (
            <p className="backend-test-progress" role="status">{probeProgressLabel(progress)}</p>
          )}
          <ul className="backend-test-results" aria-label={`Test results for ${name}`}>
            {results.map((model) => {
              const outcome = busy === "test"
                ? { outcome: "untested" as const, label: "Testing…" }
                : modelProbeOutcome(model.latestProbe);
              return (
                <li key={model.id} className={`is-${outcome.outcome}`}>
                  <span>
                    <strong>{model.displayName}</strong>
                    {model.displayName !== model.id && <code>{model.id}</code>}
                  </span>
                  <small>{outcome.label}</small>
                </li>
              );
            })}
          </ul>
          <button type="button" className="secondary-button" onClick={() => closePanel(testButtonRef)}>Hide results</button>
        </div>
      )}

      {panel === "edit" && detail && (
        <BackendProfileEditor
          profile={detail}
          actions={actions}
          disabled={disabled}
          onCancel={() => closePanel(editButtonRef)}
          onSaved={(saved) => {
            setTested(saved);
            closePanel(editButtonRef);
          }}
        />
      )}

      {panel === "remove" && (
        <div
          className="backend-remove-panel"
          role="group"
          aria-label={`Remove ${name}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closePanel(removeButtonRef);
          }}
        >
          <p>Remove {name}? Past turns keep its name. The key is forgotten.</p>
          <div className="backend-panel-actions">
            <button ref={removeCancelRef} type="button" className="secondary-button" onClick={() => closePanel(removeButtonRef)}>Cancel</button>
            <button
              type="button"
              className="secondary-button is-danger"
              aria-disabled={inactive || undefined}
              onClick={() => {
                void run("delete", async () => {
                  await actions.onDelete(profile.id);
                }, "The route could not be removed.");
              }}
            >
              {busy === "delete" ? "Removing…" : "Remove permanently"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="backend-form-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>
      )}
    </li>
  );
}
