import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";

import { backendCredentialSecretIssue } from "@shared/backend-credentials";
import { isBackendPresetId, backendPresetDefinition } from "@shared/backend-presets";
import type { ModelBackendProfileDetail } from "@shared/contracts";
import {
  backendEditDraftFromDetail,
  backendEditDraftIssues,
  backendIssueMessages,
  backendProfileSemanticUpdate,
  customCreateDraft,
  emptyCustomBackendDraft,
  type BackendProfileEditDraft,
} from "../../utils/backendProfileDraft";
import { backendProbePassed } from "../../utils/backendSettingsModel";
import { BackendDraftFields, firstIssueFieldId } from "./BackendDraftFields";
import { BackendSetupSteps } from "./BackendSetupSteps";
import {
  failureMessage,
  probeEveryModel,
  probeProgressLabel,
  type BackendProfileActions,
  type ProbeProgress,
} from "./backendSettingsActions";
import { useBackendSetup, type BackendSetupStatusListener } from "./useBackendSetup";

function focusField(id: string | null): void {
  if (!id) return;
  document.getElementById(id)?.focus();
}

export function CustomBackendCreator({
  actions,
  disabled,
  onStatus,
  onCancel,
  onDone,
}: {
  actions: Pick<
    BackendProfileActions,
    "onCreate" | "onSetCredential" | "onDiscoverModels" | "onUpdate" | "onProbe"
  >;
  disabled: boolean;
  onStatus?: BackendSetupStatusListener;
  onCancel: () => void;
  onDone: (profile: ModelBackendProfileDetail | null) => void;
}): React.JSX.Element {
  const idPrefix = useId();
  const keyId = useId();
  const keyErrorId = useId();
  const [draft, setDraft] = useState<BackendProfileEditDraft>(() => emptyCustomBackendDraft());
  const [secret, setSecret] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const setup = useBackendSetup(actions, onStatus);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (setup.phase === "done") doneRef.current(setup.profile);
  }, [setup.phase, setup.profile]);
  const busy = setup.phase === "running";
  const created = setup.profile !== null;
  const issues = backendIssueMessages(backendEditDraftIssues(draft));
  const needsSecret = draft.authenticationMode !== "none";
  const keyIssue = needsSecret && !(setup.keyStored && secret === "")
    ? backendCredentialSecretIssue(secret)
    : null;
  useEffect(() => {
    if (setup.keyStores > 0) setSecret("");
  }, [setup.keyStores]);
  const firstRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    firstRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  const submit = (): void => {
    if (disabled || busy) return;
    if (setup.phase === "done") {
      onDone(setup.profile);
      return;
    }
    setSubmitted(true);
    if (!created && issues.size > 0) {
      focusField(firstIssueFieldId(idPrefix, issues));
      return;
    }
    if (keyIssue) {
      focusField(keyId);
      return;
    }
    void setup.run({
      draft: () => customCreateDraft(draft),
      secret: needsSecret ? secret.trim() : null,
      discover: false,
    });
  };
  const visibleIssues = submitted && !created ? issues : new Map<string, string>();
  const credentialLabel = draft.authenticationMode === "bearer-token" ? "Bearer token" : "API key";
  return (
    <form
      className="backend-custom-form"
      aria-label="New custom backend"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div ref={firstRef}>
        <fieldset disabled={busy || created}>
          <BackendDraftFields
            draft={draft}
            onChange={setDraft}
            issues={visibleIssues}
            idPrefix={idPrefix}
            connection="editable"
            disabled={busy || created}
          />
        </fieldset>
      </div>
      {needsSecret && (
        <div className="backend-form-section">
          <div className="backend-field backend-key-field">
            <label htmlFor={keyId}>{credentialLabel}</label>
            <input
              id={keyId}
              className="setting-input"
              type="password"
              value={secret}
              autoComplete="off"
              spellCheck={false}
              placeholder={setup.keyStored ? "Stored secret, enter a new value to replace" : undefined}
              disabled={busy || setup.phase === "done"}
              aria-invalid={submitted && keyIssue ? true : undefined}
              aria-describedby={submitted && keyIssue ? keyErrorId : undefined}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
            {submitted && keyIssue && <span id={keyErrorId} className="backend-field-error">{keyIssue}</span>}
            <small className="backend-field-hint">Stored in your system&apos;s credential vault, never in Inertia&apos;s database.</small>
          </div>
        </div>
      )}
      <BackendSetupSteps steps={setup.steps} label="Setup progress" />
      {setup.error && (
        <p className="backend-form-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{setup.error}</p>
      )}
      {setup.phase === "done" && (
        <p className="backend-setup-done" role="status">
          {setup.profile?.displayName} is ready. Choose it in the model chooser for any chat.
        </p>
      )}
      <div className="backend-editor-actions">
        {setup.phase !== "done" && (
          <button type="button" className="secondary-button" aria-disabled={busy || undefined} onClick={() => {
            if (busy) return;
            if (created) onDone(setup.profile);
            else onCancel();
          }}>{created ? "Close" : "Cancel"}</button>
        )}
        <button type="submit" className="primary-button" aria-disabled={disabled || busy || undefined}>
          {setup.phase === "done"
            ? "Done"
            : busy
              ? "Adding…"
              : setup.phase === "failed" ? "Try again" : "Add custom backend"}
        </button>
      </div>
    </form>
  );
}

export function BackendProfileEditor({
  profile,
  actions,
  disabled,
  onCancel,
  onSaved,
}: {
  profile: ModelBackendProfileDetail;
  actions: Pick<BackendProfileActions, "onUpdate" | "onProbe" | "onDiscoverModels" | "onSetCredential">;
  disabled: boolean;
  onCancel: () => void;
  onSaved: (profile: ModelBackendProfileDetail) => void;
}): React.JSX.Element {
  const idPrefix = useId();
  const keyId = useId();
  const keyNoticeId = useId();
  const keyErrorId = useId();
  const [secret, setSecret] = useState("");
  const [original, setOriginal] = useState(() => backendEditDraftFromDetail(profile));
  const [credentialPending, setCredentialPending] = useState(false);
  const [draft, setDraft] = useState<BackendProfileEditDraft>(() => backendEditDraftFromDetail(profile));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [progress, setProgress] = useState<ProbeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    mountedRef.current = true;
    formRef.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled)")?.focus();
    return () => { mountedRef.current = false; };
  }, []);
  const builtIn = profile.source === "built-in";
  const custom = profile.preset === "custom";
  const fixedEndpoint = isBackendPresetId(profile.preset)
    ? backendPresetDefinition(profile.preset).baseUrl
    : null;
  const issues = backendIssueMessages(backendEditDraftIssues(draft));
  const canDiscover = profile.authState === "configured" || profile.authState === "not-required";
  const connectionChanged = custom && (
    draft.baseUrl.trim() !== original.baseUrl.trim()
    || draft.protocol !== original.protocol
    || draft.harnessId !== original.harnessId
    || draft.authenticationMode !== original.authenticationMode
  );
  const needsKeyAgain = (connectionChanged || credentialPending) && draft.authenticationMode !== "none";
  const keyIssue = needsKeyAgain ? backendCredentialSecretIssue(secret) : null;
  const credentialLabel = draft.authenticationMode === "bearer-token" ? "Bearer token" : "API key";
  const submit = async (): Promise<void> => {
    if (disabled || busy) return;
    setSubmitted(true);
    if (issues.size > 0) {
      focusField(firstIssueFieldId(idPrefix, issues));
      return;
    }
    if (keyIssue) {
      focusField(keyId);
      return;
    }
    const update = backendProfileSemanticUpdate(original, draft);
    const updating = Object.keys(update).length > 0;
    if (!updating && !needsKeyAgain) {
      onCancel();
      return;
    }
    const wasEnabled = profile.enabled;
    const hadKey = profile.authState === "configured";
    setBusy("save");
    setError(null);
    try {
      let saved = profile;
      if (updating) {
        saved = await actions.onUpdate(profile.id, update);
        if (mountedRef.current) {
          setOriginal(draft);
          if (needsKeyAgain) setCredentialPending(true);
        }
      }
      if (needsKeyAgain) {
        saved = await actions.onSetCredential(profile.id, secret.trim());
        if (mountedRef.current) {
          setSecret("");
          setCredentialPending(false);
        }
      } else if (hadKey && saved.authState === "missing" && draft.authenticationMode !== "none") {
        if (mountedRef.current) {
          setCredentialPending(true);
          setSubmitted(false);
          setError("The key was removed with this change. Paste it again to finish.");
        }
        return;
      }
      const routeChanged = needsKeyAgain || Object.keys(update).some((key) => key !== "displayName");
      if (routeChanged && saved.authState !== "missing" && saved.authState !== "unavailable") {
        if (mountedRef.current) setBusy("test");
        saved = await probeEveryModel(actions.onProbe, saved, (counts) => {
          if (mountedRef.current) setProgress(counts);
        });
        if (wasEnabled && !saved.enabled && backendProbePassed(saved)) {
          saved = await actions.onUpdate(profile.id, { enabled: true });
        }
      }
      if (mountedRef.current) onSaved(saved);
    } catch (reason) {
      if (mountedRef.current) setError(failureMessage(reason, "The changes could not be saved."));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };
  return (
    <form
      ref={formRef}
      className="backend-profile-form"
      aria-label={`Edit ${profile.displayName}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={Boolean(busy)}>
        <BackendDraftFields
          draft={draft}
          onChange={setDraft}
          issues={submitted ? issues : new Map()}
          idPrefix={idPrefix}
          connection={custom ? "editable" : "fixed"}
          fixedEndpoint={fixedEndpoint}
          nameLocked={builtIn}
          modelsLocked={builtIn}
          disabled={Boolean(busy)}
          onDiscover={() => actions.onDiscoverModels(profile.id)}
          discoverUnavailableReason={canDiscover ? null : "Add a key before discovering models."}
        />
      </fieldset>
      {needsKeyAgain && (
        <div className="backend-field backend-key-field">
          <p id={keyNoticeId} className="backend-field-hint" role="note">
            Changing the address needs the key again. Inertia stores it, tests the route and turns it back on if it was on.
          </p>
          <label htmlFor={keyId}>{credentialLabel}</label>
          <input
            id={keyId}
            className="setting-input"
            type="password"
            value={secret}
            autoComplete="off"
            spellCheck={false}
            disabled={Boolean(busy)}
            aria-invalid={submitted && keyIssue ? true : undefined}
            aria-describedby={submitted && keyIssue ? `${keyErrorId} ${keyNoticeId}` : keyNoticeId}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
          {submitted && keyIssue && <span id={keyErrorId} className="backend-field-error">{keyIssue}</span>}
        </div>
      )}
      {builtIn && (
        <p className="backend-field-hint">The connection and models of this built-in route are fixed. You can change how Claude tiers map to them.</p>
      )}
      {busy === "test" && progress && (
        <p className="backend-test-progress" role="status">{probeProgressLabel(progress)}</p>
      )}
      {error && <p className="backend-form-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
      <div className="backend-editor-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary-button" aria-disabled={disabled || Boolean(busy) || undefined}>
          {busy === "save" ? "Saving…" : busy === "test" ? "Testing…" : "Save"}
        </button>
      </div>
    </form>
  );
}
