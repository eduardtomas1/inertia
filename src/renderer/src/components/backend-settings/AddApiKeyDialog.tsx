import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";

import {
  backendPresetDefinition,
  type ApiKeyBackendPresetId,
} from "@shared/backend-presets";
import { backendCredentialSecretIssue } from "@shared/backend-credentials";
import { validateBackendProfileDraft } from "@shared/backend-profile-validation";
import { promptCacheTtlAllowed, type PromptCacheTtl } from "@shared/compact-on-return";
import type { ModelBackendProfileDetail } from "@shared/contracts";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus } from "../../utils/modalFocus";
import { DialogShell } from "../DialogShell";
import { BackendSetupSteps } from "./BackendSetupSteps";
import { MAX_ROUTE_MODELS, ModelDiscoveryPicker } from "./ModelDiscoveryPicker";
import { PromptCacheChoice } from "./PromptCacheChoice";
import type { BackendProfileActions } from "./backendSettingsActions";
import {
  useBackendSetup,
  type BackendSetupResume,
  type BackendSetupStatusListener,
} from "./useBackendSetup";

type ModelChoice = "defaults" | "discover";

const KEY_HINTS: Readonly<Record<string, string>> = {
  "anthropic-api-key": "Create one in the Anthropic Console. Usage is billed to your API credits.",
  "openai-api-key": "Create one at platform.openai.com. Usage is billed to your API credits.",
  "gemini-api-key": "Create one in Google AI Studio. Usage is billed to your API credits.",
};

export function AddApiKeyDialog({
  preset,
  actions,
  onStatus,
  resume,
  onClose,
}: {
  preset: ApiKeyBackendPresetId;
  actions: Pick<
    BackendProfileActions,
    "onCreate" | "onSetCredential" | "onDiscoverModels" | "onUpdate" | "onProbe"
  >;
  onStatus?: BackendSetupStatusListener;
  resume?: BackendSetupResume;
  onClose: (profile: ModelBackendProfileDetail | null) => void;
}): React.JSX.Element {
  const definition = backendPresetDefinition(preset);
  const titleId = useId();
  const descriptionId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const keyId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();
  const [name, setName] = useState(resume?.profile.displayName ?? definition.displayName);
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<ModelChoice>(resume ? "discover" : "defaults");
  const [promptCacheTtl, setPromptCacheTtl] = useState<PromptCacheTtl>("5m");
  const cacheChoice = promptCacheTtlAllowed(definition);
  const [submitted, setSubmitted] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const setup = useBackendSetup(actions, onStatus, resume);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const restore = captureModalFocus();
    if (!resume) keyRef.current?.focus();
    return restore;
  }, [resume]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (setup.phase === "done") closeRef.current(setup.profile);
  }, [setup.phase, setup.profile]);
  useEffect(() => {
    if (setup.keyStores > 0) setSecret("");
  }, [setup.keyStores]);

  const busy = setup.phase === "running";
  const created = setup.profile !== null;
  const nameIssue = validateBackendProfileDraft({ preset, displayName: name.trim() })
    .find(({ field }) => field === "name")?.message ?? null;
  const keyIssue = setup.keyStored && secret === "" ? null : backendCredentialSecretIssue(secret);
  const showNameIssue = submitted && !created ? nameIssue : null;
  const showKeyIssue = submitted ? keyIssue : null;
  const close = (): void => {
    onClose(setup.profile);
  };
  const submit = (): void => {
    if (busy || setup.phase === "choose-models") return;
    if (setup.phase === "done") {
      close();
      return;
    }
    setSubmitted(true);
    if ((!created && nameIssue) || keyIssue) {
      (keyIssue && !(!created && nameIssue) ? keyRef.current : document.getElementById(nameId))?.focus();
      return;
    }
    void setup.run({
      draft: () => ({
        preset,
        displayName: name.trim(),
        ...(cacheChoice && promptCacheTtl === "1h" ? { promptCacheTtl } : {}),
      }),
      secret: secret.trim(),
      discover: models === "discover",
    });
  };
  const submitLabel = setup.phase === "done"
    ? "Done"
    : busy
      ? "Adding…"
      : setup.phase === "failed"
        ? "Try again"
        : "Add API key";
  return createPortal(
    <DialogShell
      className="backend-key-dialog"
      titleId={titleId}
      title={`Add ${definition.displayName}`}
      description="The key is stored in your system's credential vault. Inertia checks that it works; each model is tested the first time a chat uses it."
      descriptionId={descriptionId}
      closeLabel="Close Add API key"
      onClose={close}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      footer={<>
        {setup.phase !== "done" && (
          <button type="button" className="secondary-button" onClick={close}>
            {busy ? "Close and continue" : created ? "Close" : "Cancel"}
          </button>
        )}
        <button
          type="submit"
          className="primary-button"
          aria-disabled={busy || setup.phase === "choose-models" || undefined}
        >
          {submitLabel}
        </button>
      </>}
    >
      <fieldset className="backend-key-dialog-fields" disabled={busy || setup.phase === "done"}>
        <label className="dialog-field" htmlFor={nameId}>
          <span>Name</span>
          <input
            id={nameId}
            value={name}
            maxLength={200}
            readOnly={created}
            aria-invalid={showNameIssue ? true : undefined}
            aria-describedby={showNameIssue ? nameErrorId : undefined}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        {showNameIssue && <p id={nameErrorId} className="dialog-error">{showNameIssue}</p>}
        <label className="dialog-field" htmlFor={keyId}>
          <span>API key</span>
          <input
            ref={keyRef}
            id={keyId}
            type="password"
            value={secret}
            autoComplete="off"
            spellCheck={false}
            placeholder={setup.keyStored ? "Stored secret, enter a new value to replace" : undefined}
            aria-invalid={showKeyIssue ? true : undefined}
            aria-describedby={showKeyIssue ? `${keyErrorId} ${keyHintId}` : keyHintId}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        </label>
        <p id={keyHintId} className="backend-field-hint">
          {KEY_HINTS[preset] ?? "Usage is billed to your API credits."}
        </p>
        {showKeyIssue && <p id={keyErrorId} className="dialog-error">{showKeyIssue}</p>}
        <fieldset className="backend-model-choice">
          <legend>Models</legend>
          <label>
            <input
              type="radio"
              name={`${titleId}-models`}
              value="defaults"
              checked={models === "defaults"}
              onChange={() => setModels("defaults")}
            />
            <span>
              <strong>Use the default models</strong>
              <small>{definition.defaultModels.map(({ displayName }) => displayName).join(", ")}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name={`${titleId}-models`}
              value="discover"
              checked={models === "discover"}
              onChange={() => setModels("discover")}
            />
            <span>
              <strong>Discover models from the endpoint</strong>
              <small>Inertia lists the models after the key is saved, and you choose which to add.</small>
            </span>
          </label>
        </fieldset>
        {cacheChoice && <PromptCacheChoice value={promptCacheTtl} onChange={setPromptCacheTtl} />}
      </fieldset>
      <BackendSetupSteps steps={setup.steps} label="Setup progress" />
      {setup.phase === "choose-models" && setup.discovered && (
        <ModelDiscoveryPicker
          models={setup.discovered}
          existingIds={new Set()}
          busy={false}
          autoFocusSearch={resume !== undefined}
          maxSelectable={MAX_ROUTE_MODELS}
          confirmLabel={(count) => count === 0 ? "Choose models" : `Use ${count} ${count === 1 ? "model" : "models"}`}
          onConfirm={(chosen) => { void setup.chooseModels(chosen); }}
        />
      )}
      {setup.error && (
        <p className="backend-form-error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {setup.error}
        </p>
      )}
    </DialogShell>,
    document.body,
  );
}
