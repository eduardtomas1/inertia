import { useId, useState } from "react";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import clsx from "clsx";

import type { BackendDiscoveredModel } from "@shared/contracts";
import {
  emptyBackendModel,
  mergeDiscoveredModels,
  normalizedBackendUrlPreview,
  removeBackendDraftModel,
  setBackendDraftAdvancedRouting,
  updateBackendDraftModel,
  type BackendCustomHarness,
  type BackendProfileEditDraft,
} from "../../utils/backendProfileDraft";
import { useRovingRadios } from "../../hooks/useRovingRadios";
import { IconButton, Switch } from "../ui";
import { SettingCopy } from "../settings/SettingsLayout";
import { ModelDiscoveryPicker } from "./ModelDiscoveryPicker";
import { failureMessage } from "./backendSettingsActions";

const routingModes = ["simple", "advanced"] as const;
const MAX_MODELS = 128;

export interface BackendDraftFieldsProps {
  draft: BackendProfileEditDraft;
  onChange: (draft: BackendProfileEditDraft) => void;
  issues: ReadonlyMap<string, string>;
  idPrefix: string;
  connection: "editable" | "fixed" | "hidden";
  fixedEndpoint?: string | null;
  nameLocked?: boolean;
  modelsLocked?: boolean;
  disabled?: boolean;
  onDiscover?: () => Promise<BackendDiscoveredModel[]>;
  discoverUnavailableReason?: string | null;
}

function FieldError({ id, message }: { id: string; message: string | undefined }): React.JSX.Element | null {
  if (!message) return null;
  return <span id={id} className="backend-field-error">{message}</span>;
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

export function BackendDraftFields({
  draft,
  onChange,
  issues,
  idPrefix,
  connection,
  fixedEndpoint = null,
  nameLocked = false,
  modelsLocked = false,
  disabled = false,
  onDiscover,
  discoverUnavailableReason = null,
}: BackendDraftFieldsProps): React.JSX.Element {
  const urlPreviewId = useId();
  const [edited, setEdited] = useState<readonly boolean[]>(() =>
    draft.models.map(({ id, displayName }) => displayName.length > 0 && displayName !== id));
  const [discovery, setDiscovery] = useState<
    | { state: "idle" }
    | { state: "loading" }
    | { state: "ready"; models: BackendDiscoveredModel[] }
    | { state: "failed"; message: string }
  >({ state: "idle" });
  const advanced = draft.routing.mode === "advanced";
  const claudeHarness = draft.harnessId === "claude-agent-sdk";
  const setAdvancedRouting = (enabled: boolean): void => {
    if (!claudeHarness) return;
    onChange(setBackendDraftAdvancedRouting(draft, enabled));
  };
  const routingRadios = useRovingRadios(
    routingModes,
    advanced ? "advanced" : "simple",
    (mode) => setAdvancedRouting(mode === "advanced"),
  );
  const nameFollows = (index: number): boolean => !(edited[index] ?? true);
  const setHarness = (harnessId: BackendCustomHarness): void => {
    onChange({
      ...draft,
      harnessId,
      protocol: harnessId === "claude-agent-sdk" ? "anthropic-messages" : "openai-responses",
      authenticationMode: harnessId === "claude-agent-sdk" && draft.authenticationMode === "none"
        ? "api-key"
        : draft.authenticationMode,
      routing: { mode: "simple", primaryModelId: draft.models[0]?.id ?? "" },
    });
  };
  const updateModel = (
    index: number,
    field: "id" | "displayName" | "contextWindowTokens",
    value: string,
  ): void => {
    if (field === "displayName") {
      setEdited((current) => current.map((flag, flagIndex) =>
        flagIndex === index ? value.trim().length > 0 : flag));
    }
    onChange(updateBackendDraftModel(draft, index, field, value, {
      nameFollowsId: field === "id" && nameFollows(index),
    }));
  };
  const addModel = (): void => {
    if (draft.models.length >= MAX_MODELS) return;
    setEdited((current) => [...current, false]);
    onChange({ ...draft, models: [...draft.models, emptyBackendModel()] });
  };
  const removeModel = (index: number): void => {
    setEdited((current) => current.filter((_, flagIndex) => flagIndex !== index));
    onChange(removeBackendDraftModel(draft, index));
  };
  const discover = async (): Promise<void> => {
    if (!onDiscover || discovery.state === "loading") return;
    setDiscovery({ state: "loading" });
    try {
      const models = await onDiscover();
      setDiscovery(models.length > 0
        ? { state: "ready", models }
        : { state: "failed", message: "The endpoint did not list any models." });
    } catch (reason) {
      setDiscovery({ state: "failed", message: failureMessage(reason, "The models could not be listed.") });
    }
  };
  const addDiscovered = (models: readonly BackendDiscoveredModel[]): void => {
    const merged = mergeDiscoveredModels(draft, models);
    setEdited(merged.models.map((model) => {
      const previous = draft.models.findIndex(({ id }) => id === model.id);
      return previous >= 0 ? edited[previous] ?? true : true;
    }));
    onChange(merged);
    setDiscovery({ state: "idle" });
  };
  const urlPreview = connection === "editable"
    ? normalizedBackendUrlPreview(draft.protocol, draft.baseUrl)
    : null;
  const modelOptions = draft.models.filter(({ id }) => id.trim().length > 0);
  const modelOptionLabel = (model: { id: string; displayName: string }): string =>
    model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id;
  const nameError = issues.get("name");
  const urlError = issues.get("baseUrl");
  const authError = issues.get("authenticationMode");
  const protocolError = issues.get("protocol");
  const modelsError = issues.get("models");
  const contextError = issues.get("contextWindow");
  const idPlaceholder = draft.protocol === "anthropic-messages" ? "claude-sonnet-5-5" : "gpt-6.1-sol";

  return (
    <>
      {connection === "editable" && (
        <div className="backend-form-section">
          <p className="backend-subheading">Harness</p>
          <div className="backend-choice-grid">
            <button type="button" disabled={disabled} aria-pressed={draft.harnessId === "claude-agent-sdk"} className={clsx(draft.harnessId === "claude-agent-sdk" && "is-active")} onClick={() => setHarness("claude-agent-sdk")}><span><strong>Claude harness</strong><small>Anthropic Messages-compatible</small></span>{draft.harnessId === "claude-agent-sdk" && <Check size={14} aria-hidden="true" />}</button>
            <button type="button" disabled={disabled} aria-pressed={draft.harnessId === "codex-app-server"} className={clsx(draft.harnessId === "codex-app-server" && "is-active")} onClick={() => setHarness("codex-app-server")}><span><strong>Codex harness</strong><small>OpenAI Responses-compatible</small></span>{draft.harnessId === "codex-app-server" && <Check size={14} aria-hidden="true" />}</button>
          </div>
          {protocolError && <span className="backend-field-error" role="alert">{protocolError}</span>}
        </div>
      )}

      <div className="backend-form-section">
        <p className="backend-subheading">{connection === "editable" ? "Connection" : "Route"}</p>
        <div className="backend-form-grid">
          <div className="backend-field">
            <label htmlFor={`${idPrefix}-name`}>Name</label>
            <input
              id={`${idPrefix}-name`}
              className="setting-input"
              disabled={disabled || nameLocked}
              value={draft.displayName}
              maxLength={200}
              placeholder="Team gateway"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={describedBy(nameError && `${idPrefix}-name-error`)}
              onChange={(event) => onChange({ ...draft, displayName: event.currentTarget.value })}
            />
            <FieldError id={`${idPrefix}-name-error`} message={nameError} />
          </div>
          {connection === "editable" && (
            <div className="backend-field">
              <label htmlFor={`${idPrefix}-authenticationMode`}>Authentication</label>
              <select
                id={`${idPrefix}-authenticationMode`}
                className="setting-select"
                disabled={disabled}
                value={draft.authenticationMode}
                aria-invalid={authError ? true : undefined}
                aria-describedby={describedBy(authError && `${idPrefix}-auth-error`)}
                onChange={(event) => onChange({
                  ...draft,
                  authenticationMode: event.currentTarget.value as BackendProfileEditDraft["authenticationMode"],
                })}
              >
                <option value="api-key">API key</option>
                <option value="bearer-token">Bearer token</option>
                {!claudeHarness && <option value="none">No authentication</option>}
              </select>
              <FieldError id={`${idPrefix}-auth-error`} message={authError} />
            </div>
          )}
          {connection === "editable" && (
            <div className="backend-field backend-form-wide">
              <label htmlFor={`${idPrefix}-baseUrl`}>Base URL</label>
              <input
                id={`${idPrefix}-baseUrl`}
                className="setting-input"
                disabled={disabled}
                value={draft.baseUrl}
                maxLength={2048}
                spellCheck={false}
                inputMode="url"
                placeholder={claudeHarness ? "https://gateway.example.com" : "https://gateway.example.com/v1"}
                aria-invalid={urlError ? true : undefined}
                aria-describedby={describedBy(urlError && `${idPrefix}-url-error`, urlPreview && urlPreviewId)}
                onChange={(event) => onChange({ ...draft, baseUrl: event.currentTarget.value })}
              />
              <FieldError id={`${idPrefix}-url-error`} message={urlError} />
              {urlPreview && (
                <small id={urlPreviewId} className="backend-field-hint">Inertia connects to {urlPreview}</small>
              )}
            </div>
          )}
        </div>
        {connection === "fixed" && fixedEndpoint && (
          <p className="backend-field-hint">Connects to {fixedEndpoint}. The address is fixed for this route.</p>
        )}
        {connection === "editable" && (
          <>
            <div className="setting-row backend-form-toggle">
              <SettingCopy title="Allow localhost HTTP" description="For local development only. Other endpoints must use HTTPS." />
              <Switch label="Allow localhost HTTP" checked={draft.allowInsecureLocalhost} disabled={disabled} onChange={(allowInsecureLocalhost) => onChange({ ...draft, allowInsecureLocalhost })} />
            </div>
            <div className="setting-row backend-form-toggle">
              <SettingCopy title="Allow private network addresses" description="Lets this backend reach addresses on your own network or VPN, such as 10.0.0.5. Turn it on only for a server you trust." />
              <Switch label="Allow private network addresses" checked={draft.allowPrivateNetwork} disabled={disabled} onChange={(allowPrivateNetwork) => onChange({ ...draft, allowPrivateNetwork })} />
            </div>
          </>
        )}
      </div>

      <div className="backend-form-section">
        <div className="backend-form-section-heading">
          <p className="backend-subheading" id={`${idPrefix}-models-heading`}>Models</p>
          <span className="backend-form-section-actions">
            {onDiscover && !modelsLocked && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                aria-disabled={discovery.state === "loading" || Boolean(discoverUnavailableReason) || undefined}
                title={discoverUnavailableReason ?? undefined}
                onClick={() => { if (!discoverUnavailableReason) void discover(); }}
              >
                <Search size={14} aria-hidden="true" />
                {discovery.state === "loading" ? "Discovering…" : "Discover models"}
              </button>
            )}
            {!modelsLocked && (
              <button type="button" className="secondary-button" disabled={disabled || draft.models.length >= MAX_MODELS} onClick={addModel}>
                <Plus size={14} aria-hidden="true" />Add model
              </button>
            )}
          </span>
        </div>
        {discoverUnavailableReason && onDiscover && !modelsLocked && (
          <p className="backend-field-hint">{discoverUnavailableReason}</p>
        )}
        {discovery.state === "failed" && <p className="backend-field-error" role="alert">{discovery.message}</p>}
        {discovery.state === "ready" && (
          <ModelDiscoveryPicker
            models={discovery.models}
            existingIds={new Set(draft.models.map(({ id }) => id))}
            busy={disabled}
            maxSelectable={MAX_MODELS - draft.models.filter(({ id }) => id.trim()).length}
            confirmLabel={(count) => count === 0 ? "Add models" : `Add ${count} ${count === 1 ? "model" : "models"}`}
            onConfirm={addDiscovered}
            onCancel={() => setDiscovery({ state: "idle" })}
          />
        )}
        {modelsError && <span className="backend-field-error" role="alert">{modelsError}</span>}
        <div className="backend-editable-models" role="group" aria-labelledby={`${idPrefix}-models-heading`}>
          {draft.models.map((model, index) => {
            const number = index + 1;
            const idError = issues.get(`models.${index}.id`);
            const displayError = issues.get(`models.${index}.displayName`);
            return (
              <div className="backend-editable-model" key={index}>
                <div className="backend-field">
                  <label htmlFor={`${idPrefix}-models.${index}.id`}>Model {number} ID</label>
                  <input
                    id={`${idPrefix}-models.${index}.id`}
                    className="setting-input"
                    disabled={disabled || modelsLocked}
                    value={model.id}
                    maxLength={500}
                    spellCheck={false}
                    placeholder={idPlaceholder}
                    aria-invalid={idError ? true : undefined}
                    aria-describedby={describedBy(idError && `${idPrefix}-model-${index}-id-error`)}
                    onChange={(event) => updateModel(index, "id", event.currentTarget.value)}
                  />
                  <FieldError id={`${idPrefix}-model-${index}-id-error`} message={idError} />
                </div>
                <div className="backend-field">
                  <label htmlFor={`${idPrefix}-models.${index}.displayName`}>Model {number} display name</label>
                  <input
                    id={`${idPrefix}-models.${index}.displayName`}
                    className="setting-input"
                    disabled={disabled || modelsLocked}
                    value={model.displayName}
                    maxLength={200}
                    placeholder="Shown in the model chooser"
                    aria-invalid={displayError ? true : undefined}
                    aria-describedby={describedBy(displayError && `${idPrefix}-model-${index}-name-error`)}
                    onChange={(event) => updateModel(index, "displayName", event.currentTarget.value)}
                  />
                  <FieldError id={`${idPrefix}-model-${index}-name-error`} message={displayError} />
                </div>
                <div className="backend-field">
                  <label htmlFor={`${idPrefix}-models.${index}.contextWindowTokens`}>Model {number} context tokens</label>
                  <input
                    id={`${idPrefix}-models.${index}.contextWindowTokens`}
                    className="setting-input"
                    disabled={disabled || modelsLocked}
                    type="number"
                    min={8192}
                    max={100000000}
                    value={model.contextWindowTokens ?? ""}
                    placeholder="Unknown"
                    onChange={(event) => updateModel(index, "contextWindowTokens", event.currentTarget.value)}
                  />
                </div>
                <IconButton
                  label={`Remove model ${number}${model.id ? ` (${model.id})` : ""}`}
                  disabled={disabled || modelsLocked || draft.models.length <= 1}
                  onClick={() => removeModel(index)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </IconButton>
              </div>
            );
          })}
        </div>
        {contextError && <span className="backend-field-error" role="alert">{contextError}</span>}
        {claudeHarness && (
          <div className="response-density-setting backend-routing-mode">
            <SettingCopy title="Model mapping" description="Simple sends every Claude tier and subagent to the primary model. Advanced maps each one to any configured model." />
            <div role="radiogroup" aria-label="Model mapping" {...routingRadios.groupProps}>
              <button type="button" disabled={disabled} className={!advanced ? "is-active" : undefined} {...routingRadios.radioProps("simple")}>Simple</button>
              <button type="button" disabled={disabled} className={advanced ? "is-active" : undefined} {...routingRadios.radioProps("advanced")}>Advanced</button>
            </div>
          </div>
        )}
        {modelOptions.length > 0 && (
          <div className="backend-tier-grid backend-primary-model">
            <label><span>Primary model</span><select className="setting-select" disabled={disabled} value={draft.routing.primaryModelId} onChange={(event) => onChange({ ...draft, routing: { ...draft.routing, primaryModelId: event.currentTarget.value } })}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{modelOptionLabel(model)}</option>)}</select></label>
          </div>
        )}
        {draft.routing.mode === "advanced" && modelOptions.length > 0 && (
          <div className="backend-tier-grid">
            {(["fable", "opus", "sonnet", "haiku"] as const).map((tier) => (
              <label key={tier}><span>{tier[0]!.toUpperCase() + tier.slice(1)}</span><select className="setting-select" disabled={disabled} value={draft.routing.mode === "advanced" ? draft.routing.tierModels[tier] : ""} onChange={(event) => {
                if (draft.routing.mode !== "advanced") return;
                onChange({ ...draft, routing: { ...draft.routing, tierModels: { ...draft.routing.tierModels, [tier]: event.currentTarget.value } } });
              }}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{modelOptionLabel(model)}</option>)}</select></label>
            ))}
            <label><span>Subagents</span><select className="setting-select" disabled={disabled} value={draft.routing.subagentModelId} onChange={(event) => {
              if (draft.routing.mode !== "advanced") return;
              onChange({ ...draft, routing: { ...draft.routing, subagentModelId: event.currentTarget.value } });
            }}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{modelOptionLabel(model)}</option>)}</select></label>
            <label><span>Compaction</span><select className="setting-select" value="unavailable" disabled><option value="unavailable">Unavailable in Claude harness override</option></select></label>
          </div>
        )}
      </div>
    </>
  );
}

export function firstIssueFieldId(
  idPrefix: string,
  issues: ReadonlyMap<string, string>,
): string | null {
  const field = issues.keys().next().value;
  if (!field) return null;
  if (field === "models" || field === "contextWindow") return `${idPrefix}-models.0.id`;
  if (field === "protocol") return null;
  return `${idPrefix}-${field}`;
}
