import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  LoaderCircle,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  type BackendModelDefinition,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelBackendProfileView,
} from "@shared/contracts";
import {
  backendProfileSemanticUpdate,
  backendProfileIsReady,
  setBackendDraftAdvancedRouting,
  updateBackendDraftModel,
} from "../utils/backendProfileDraft";
import { useRovingRadios } from "../hooks/useRovingRadios";
import { IconButton, LoadingMark, Switch } from "./ui";
import { SettingDisclosure, SettingCopy } from "./settings/SettingsLayout";
import "./ModelBackendsSettings.css";

type ModelBackendsSettingsProps = {
  profiles: ModelBackendProfileView[];
  initialProfileId?: string;
  disabled: boolean;
  onLoadDetail: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onCreate: (draft: ModelBackendProfileDraft) => Promise<ModelBackendProfileDetail>;
  onUpdate: (
    profileId: string,
    update: Partial<ModelBackendProfileDraft> & { enabled?: boolean },
  ) => Promise<ModelBackendProfileDetail>;
  onSetCredential: (
    profileId: string,
    secret: string,
  ) => Promise<ModelBackendProfileDetail>;
  onClearCredential: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onProbe: (
    profileId: string,
    modelId: string,
  ) => Promise<ModelBackendProfileDetail>;
  onDelete: (profileId: string) => Promise<void>;
};

const emptyCapabilities: BackendModelDefinition["capabilities"] = [];
const routingModes = ["simple", "advanced"] as const;
const defaultReasoning = [
  { value: "auto", label: "Auto", description: "Let the backend choose." },
  { value: "low", label: "Low", description: "Use less reasoning." },
  { value: "medium", label: "Medium", description: "Use balanced reasoning." },
  { value: "high", label: "High", description: "Use deeper reasoning." },
] as const;

function defaultDraft(): ModelBackendProfileDraft {
  const model: BackendModelDefinition = {
    id: "custom-model",
    displayName: "custom-model",
    contextWindowTokens: null,
    reasoningOptions: [...defaultReasoning],
    capabilities: emptyCapabilities,
  };
  return {
    displayName: "Custom endpoint",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    preset: "custom",
    baseUrl: "https://api.example.com",
    allowInsecureLocalhost: false,
    models: [model],
    routing: { mode: "simple", primaryModelId: model.id },
    capabilityHints: [],
  };
}

function harnessLabel(profile: Pick<ModelBackendProfileView, "harnessId">): string {
  const harness = profile.harnessId.startsWith("claude")
    ? "Claude"
    : profile.harnessId.startsWith("codex")
      ? "Codex"
      : profile.harnessId.startsWith("cursor")
        ? "Cursor"
          : profile.harnessId.startsWith("antigravity")
            ? "Antigravity"
            : profile.harnessId.startsWith("kimi")
              ? "Kimi Code"
              : "OpenCode";
  return `${harness} harness`;
}

function identityLabel(profile: ModelBackendProfileView): string {
  return `${harnessLabel(profile)} · ${profile.displayName}`;
}

function statusLabel(profile: ModelBackendProfileView): string {
  if (profile.compatibility.state === "verified") return "Verified";
  if (profile.compatibility.state === "partially-compatible") return "Partial";
  if (profile.compatibility.state === "user-declared") return "User declared";
  if (profile.compatibility.state === "unavailable") return "Unavailable";
  return "Not checked";
}

function formattedContext(tokens: number | null): string {
  if (!tokens) return "Unknown";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

function protocolLabel(protocol: ModelBackendProfileView["protocol"]): string {
  if (protocol === "anthropic-messages") return "Anthropic Messages";
  if (protocol === "openai-responses") return "OpenAI Responses";
  return protocol;
}

function credentialDescription(profile: ModelBackendProfileView): string {
  if (profile.authState === "configured") return "Stored in your operating system’s secure vault.";
  if (profile.authState === "harness-managed") return "Managed by the harness.";
  if (profile.authState === "not-required") return "Not required for this profile.";
  if (profile.authState === "checking") return "Checking…";
  if (profile.authState === "unavailable") return "The secure vault is unavailable.";
  return "No usable credential is available for this profile.";
}

function connectionLabel(state: ModelBackendProfileView["connectionState"]): string {
  if (state === "testing") return "Testing…";
  if (state === "connected") return "Connected";
  if (state === "limited") return "Limited";
  if (state === "failed") return "Failed";
  return "Not tested";
}

function capabilityLabel(id: string): string {
  const words = id.replaceAll("-", " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

const CAPABILITY_STATE_LABELS: Readonly<Record<BackendModelDefinition["capabilities"][number]["state"], string>> = {
  verified: "Verified",
  "partially-compatible": "Partial",
  "user-declared": "User declared",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

const PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  provider: "from the provider",
  harness: "from the harness",
  probe: "from a connection test",
  user: "declared by you",
  "built-in": "built in",
  unknown: "source unknown",
};

function profileState(profile: ModelBackendProfileView): { tone: "ready" | "attention" | "unavailable" | "idle" | "checking"; label: string } {
  if (!profile.enabled) return { tone: "idle", label: "Off" };
  if (backendProfileIsReady(profile)) return { tone: "ready", label: "Ready" };
  if (profile.connectionState === "testing" || profile.authState === "checking") return { tone: "checking", label: "Checking" };
  if (profile.authState === "missing" || profile.authState === "unavailable") return { tone: "attention", label: "Needs credential" };
  if (profile.connectionState === "failed") return { tone: "unavailable", label: "Connection failed" };
  if (profile.compatibility.state === "unavailable") return { tone: "unavailable", label: "Unavailable" };
  return { tone: "idle", label: "Not tested" };
}

function BackendProfileState({ profile }: { profile: ModelBackendProfileView }): React.JSX.Element {
  const { tone, label } = profileState(profile);
  const Icon = tone === "ready" ? CheckCircle2 : tone === "checking" ? LoaderCircle : tone === "idle" ? CircleDot : CircleAlert;
  return (
    <span className={clsx("backend-profile-state", `is-${tone}`)}>
      <Icon size={13} aria-hidden="true" className={tone === "checking" ? "provider-status-spinner" : undefined} />
      {label}
    </span>
  );
}

interface BackendCredentialDraft {
  profileId: string;
  configurationRevision: number;
  value: string;
}

export function ModelBackendsSettings({
  profiles,
  initialProfileId,
  disabled,
  onLoadDetail,
  onCreate,
  onUpdate,
  onSetCredential,
  onClearCredential,
  onProbe,
  onDelete,
}: ModelBackendsSettingsProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    profiles.find(({ id }) => id === initialProfileId)?.id
      ?? profiles.find(({ id }) => id === "builtin:kimi-code")?.id
      ?? profiles[0]?.id
      ?? null,
  );
  const [detail, setDetail] = useState<ModelBackendProfileDetail | null>(null);
  const [draft, setDraft] = useState<ModelBackendProfileDraft | null>(null);
  const [originalDraft, setOriginalDraft] =
    useState<ModelBackendProfileDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [credentialDraft, setCredentialDraft] =
    useState<BackendCredentialDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocusRef = useRef(false);
  const selectionEpochRef = useRef(0);
  const selected = profiles.find(({ id }) => id === selectedId) ?? profiles[0] ?? null;
  const selectedProfileId = selected?.id ?? null;
  const selectedAuthorityRef = useRef({
    profileId: selectedProfileId,
    configurationRevision: selected?.configurationRevision ?? null,
  });
  selectedAuthorityRef.current = {
    profileId: selectedProfileId,
    configurationRevision: selected?.configurationRevision ?? null,
  };
  const secret = credentialDraft?.profileId === selectedProfileId
    && credentialDraft.configurationRevision === selected?.configurationRevision
    ? credentialDraft.value
    : "";
  const editingBuiltIn = Boolean(editingId && selected?.source === "built-in");
  useEffect(() => {
    if (!selected && profiles[0]) setSelectedId(profiles[0].id);
  }, [profiles, selected]);

  useEffect(() => {
    setCredentialDraft((current) =>
      current
      && (
        current.profileId !== selectedProfileId
        || current.configurationRevision !== selected?.configurationRevision
      )
        ? null
        : current);
  }, [selected?.configurationRevision, selectedProfileId]);

  useEffect(() => {
    if (!selectedProfileId || draft) return;
    let disposed = false;
    setDetail(null);
    setDeleteConfirm(false);
    void onLoadDetail(selectedProfileId).then(
      (value) => { if (!disposed) setDetail(value); },
      (reason: unknown) => {
        if (!disposed) setError(
          reason instanceof Error ? reason.message : "The backend details could not be loaded.",
        );
      },
    );
    return () => { disposed = true; };
  }, [draft, onLoadDetail, selectedProfileId]);

  useLayoutEffect(() => {
    if (deleteConfirm) {
      deleteCancelRef.current?.focus();
      return;
    }
    if (!restoreDeleteFocusRef.current) return;
    restoreDeleteFocusRef.current = false;
    deleteRef.current?.focus();
  }, [deleteConfirm]);

  const run = async (
    key: string,
    operation: (isCurrent: () => boolean) => Promise<ModelBackendProfileDetail | void>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    if (busy) return;
    const selectionEpoch = selectionEpochRef.current;
    const ownsDraft = draft !== null;
    const ownsResponse = (): boolean => (
      isCurrent()
      && selectionEpochRef.current === selectionEpoch
      && (ownsDraft || selectedAuthorityRef.current.profileId === selectedProfileId)
    );
    setBusy(key);
    setError(null);
    try {
      const value = await operation(ownsResponse);
      if (value && ownsResponse()) {
        setDetail(value);
        setSelectedId(value.id);
      }
    } catch (reason) {
      if (ownsResponse()) {
        setError(reason instanceof Error ? reason.message : "The backend change could not be saved.");
      }
    } finally {
      setBusy(null);
    }
  };

  const create = async (): Promise<void> => {
    if (!draft) return;
    await run(editingId ? "save" : "create", async (isCurrent) => {
      const value = editingId
        ? await onUpdate(
            editingId,
            originalDraft
              ? backendProfileSemanticUpdate(originalDraft, draft)
              : draft,
          )
        : await onCreate(draft);
      if (isCurrent()) {
        setDraft(null);
        setOriginalDraft(null);
        setEditingId(null);
      }
      return value;
    });
  };

  const beginEdit = (profile: ModelBackendProfileDetail): void => {
    if (profile.preset === "native") return;
    selectionEpochRef.current += 1;
    setCredentialDraft(null);
    setEditingId(profile.id);
    setAdvanced(profile.routing.mode === "advanced");
    const nextDraft: ModelBackendProfileDraft = {
      displayName: profile.displayName,
      harnessId: profile.harnessId,
      protocol: profile.protocol,
      authenticationMode: profile.authenticationMode,
      preset: profile.preset,
      baseUrl: profile.baseUrl ?? "",
      allowInsecureLocalhost: profile.allowInsecureLocalhost,
      models: profile.models.map((model) => ({
        ...model,
        reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
        capabilities: model.capabilities.map((capability) => ({ ...capability })),
      })),
      routing: profile.routing.mode === "simple"
        ? { ...profile.routing }
        : { ...profile.routing, tierModels: { ...profile.routing.tierModels } },
      capabilityHints: profile.capabilityHints.map((capability) => ({ ...capability })),
    };
    setDraft(nextDraft);
    setOriginalDraft(structuredClone(nextDraft));
    setError(null);
  };

  const cancelEditing = (): void => {
    selectionEpochRef.current += 1;
    setDraft(null);
    setOriginalDraft(null);
    setEditingId(null);
  };

  const setHarness = (harness: "claude-agent-sdk" | "codex-app-server"): void => {
    if (!draft) return;
    setDraft({
      ...draft,
      harnessId: harness,
      protocol: harness === "claude-agent-sdk"
        ? "anthropic-messages"
        : "openai-responses",
      routing: {
        mode: "simple",
        primaryModelId: draft.models[0]?.id ?? "custom-model",
      },
    });
    setAdvanced(false);
  };

  const updateDraftModel = (
    index: number,
    field: "id" | "displayName" | "contextWindowTokens",
    value: string,
  ): void => {
    if (!draft) return;
    setDraft(updateBackendDraftModel(draft, index, field, value));
  };

  const addDraftModel = (): void => {
    if (!draft || draft.models.length >= 128) return;
    let suffix = draft.models.length + 1;
    while (draft.models.some(({ id }) => id === `custom-model-${suffix}`)) suffix += 1;
    setDraft({
      ...draft,
      models: [
        ...draft.models,
        {
          id: `custom-model-${suffix}`,
          displayName: `Custom model ${suffix}`,
          contextWindowTokens: null,
          reasoningOptions: [...defaultReasoning],
          capabilities: emptyCapabilities,
        },
      ],
    });
  };

  const removeDraftModel = (index: number): void => {
    if (!draft || draft.models.length <= 1) return;
    const removed = draft.models[index];
    if (!removed) return;
    const remaining = draft.models.filter((_, modelIndex) => modelIndex !== index);
    const replacement = remaining[0]!.id;
    const replace = (modelId: string): string =>
      modelId === removed.id ? replacement : modelId;
    setDraft({
      ...draft,
      models: remaining,
      routing: draft.routing.mode === "simple"
        ? { ...draft.routing, primaryModelId: replace(draft.routing.primaryModelId) }
        : {
            ...draft.routing,
            primaryModelId: replace(draft.routing.primaryModelId),
            tierModels: Object.fromEntries(
              Object.entries(draft.routing.tierModels)
                .map(([tier, modelId]) => [tier, replace(modelId)]),
            ) as typeof draft.routing.tierModels,
            subagentModelId: replace(draft.routing.subagentModelId),
          },
    });
  };

  const setAdvancedRouting = (enabled: boolean): void => {
    if (!draft || draft.harnessId !== "claude-agent-sdk") return;
    setAdvanced(enabled);
    setDraft(setBackendDraftAdvancedRouting(draft, enabled));
  };
  const routingRadios = useRovingRadios(
    routingModes,
    advanced ? "advanced" : "simple",
    (mode) => setAdvancedRouting(mode === "advanced"),
  );

  const busyNow = Boolean(busy);
  const capabilities = selected ? selected.latestProbe?.capabilities ?? selected.capabilityHints : [];

  return (
    <section className="settings-card backend-settings" aria-labelledby="backends-heading" data-setting-id="model-backends">
      <div className="settings-card-heading backend-settings-toolbar">
        <span>
          <h3 id="backends-heading">Custom backends</h3>
          <p>Route chats through your own compatible endpoint.</p>
        </span>
        <button
          type="button"
          className="secondary-button"
          aria-disabled={disabled || busyNow || undefined}
          onClick={() => {
            if (disabled || busyNow) return;
            cancelEditing();
            setCredentialDraft(null);
            setDraft(defaultDraft());
            setDetail(null);
            setError(null);
          }}
        >
          <Plus size={14} aria-hidden="true" />New profile
        </button>
      </div>

      <div className="backend-settings-grid">
        <aside className="backend-profile-rail" aria-label="Backend profiles">
          {profiles.map((profile) => (
            <button
              type="button"
              className={clsx(
                "backend-profile-rail-item",
                !draft && selected?.id === profile.id && "is-active",
              )}
              aria-current={!draft && selected?.id === profile.id ? "true" : undefined}
              onClick={() => {
                cancelEditing();
                setCredentialDraft(null);
                setSelectedId(profile.id);
                setError(null);
              }}
              key={profile.id}
              title={identityLabel(profile)}
            >
              <strong>{profile.displayName}</strong>
              <small>{profile.endpointHost ?? (profile.preset === "native" ? "Harness managed" : "Endpoint hidden")}</small>
              <BackendProfileState profile={profile} />
            </button>
          ))}
        </aside>

        <div className="backend-profile-editor">
          {draft ? (
            <>
              <div className="backend-profile-header">
                <span className="backend-profile-header-copy">
                  <strong>{editingId ? "Edit backend configuration" : "New backend profile"}</strong>
                  <small>{editingId ? "Saving changes to the connection starts a new revision that needs a fresh connection test." : "Custom endpoints stay separate from native provider configuration."}</small>
                </span>
                <IconButton label="Cancel profile editing" onClick={cancelEditing}><X size={15} aria-hidden="true" /></IconButton>
              </div>

              <fieldset disabled={busy === "save" || busy === "create"}>
                <div className="backend-form-section">
                  <p className="backend-subheading">Harness</p>
                  <div className="backend-choice-grid">
                    <button type="button" disabled={editingBuiltIn} aria-pressed={draft.harnessId === "claude-agent-sdk"} className={clsx(draft.harnessId === "claude-agent-sdk" && "is-active")} onClick={() => setHarness("claude-agent-sdk")}><span><strong>Claude harness</strong><small>Anthropic Messages-compatible</small></span>{draft.harnessId === "claude-agent-sdk" && <Check size={14} aria-hidden="true" />}</button>
                    <button type="button" disabled={editingBuiltIn} aria-pressed={draft.harnessId === "codex-app-server"} className={clsx(draft.harnessId === "codex-app-server" && "is-active")} onClick={() => setHarness("codex-app-server")}><span><strong>Codex harness</strong><small>OpenAI Responses-compatible</small></span>{draft.harnessId === "codex-app-server" && <Check size={14} aria-hidden="true" />}</button>
                  </div>
                </div>

                <div className="backend-form-section">
                  <p className="backend-subheading">Connection</p>
                  <div className="backend-form-grid">
                    <label><span>Name</span><input className="setting-input" disabled={editingBuiltIn} value={draft.displayName} maxLength={200} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
                    <label><span>Authentication</span><select className="setting-select" disabled={editingBuiltIn} value={draft.authenticationMode} onChange={(event) => setDraft({ ...draft, authenticationMode: event.target.value as ModelBackendProfileDraft["authenticationMode"] })}><option value="api-key">API key</option><option value="bearer-token">Bearer token</option><option value="none">No credential</option></select></label>
                    <label className="backend-form-wide"><span>Base URL</span><input className="setting-input" disabled={editingBuiltIn} value={draft.baseUrl} maxLength={2048} spellCheck={false} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
                  </div>
                  <div className="setting-row backend-form-toggle">
                    <SettingCopy title="Allow localhost HTTP" description={editingBuiltIn ? "Built-in connection settings are fixed; model mappings stay editable." : "For local development only. Other endpoints must use HTTPS."} />
                    <Switch label="Allow localhost HTTP" checked={draft.allowInsecureLocalhost} disabled={editingBuiltIn} onChange={(allowInsecureLocalhost) => setDraft({ ...draft, allowInsecureLocalhost })} />
                  </div>
                </div>

                <div className="backend-form-section">
                  <div className="backend-form-section-heading">
                    <p className="backend-subheading">Models</p>
                    <button type="button" className="secondary-button" disabled={editingBuiltIn} onClick={addDraftModel}><Plus size={14} aria-hidden="true" />Add model</button>
                  </div>
                  <div className="backend-editable-models">
                    {draft.models.map((model, index) => (
                      <div className="backend-editable-model" key={index}>
                        <label><span>Model ID</span><input className="setting-input" disabled={editingBuiltIn} value={model.id} maxLength={500} spellCheck={false} onChange={(event) => updateDraftModel(index, "id", event.target.value)} /></label>
                        <label><span>Display name</span><input className="setting-input" disabled={editingBuiltIn} value={model.displayName} maxLength={200} onChange={(event) => updateDraftModel(index, "displayName", event.target.value)} /></label>
                        <label><span>Context tokens</span><input className="setting-input" disabled={editingBuiltIn} type="number" min={8192} max={100000000} value={model.contextWindowTokens ?? ""} placeholder="Unknown" onChange={(event) => updateDraftModel(index, "contextWindowTokens", event.target.value)} /></label>
                        <IconButton label={`Remove ${model.displayName}`} disabled={editingBuiltIn || draft.models.length <= 1} onClick={() => removeDraftModel(index)}><Trash2 size={14} aria-hidden="true" /></IconButton>
                      </div>
                    ))}
                  </div>
                  {draft.harnessId === "claude-agent-sdk" && (
                    <div className="response-density-setting backend-routing-mode">
                      <SettingCopy title="Model mapping" description="Simple sends every Claude tier and subagent to the primary model. Advanced maps each one to any configured model." />
                      <div role="radiogroup" aria-label="Model mapping" {...routingRadios.groupProps}>
                        <button type="button" className={!advanced ? "is-active" : undefined} {...routingRadios.radioProps("simple")}>Simple</button>
                        <button type="button" className={advanced ? "is-active" : undefined} {...routingRadios.radioProps("advanced")}>Advanced</button>
                      </div>
                    </div>
                  )}
                  <div className="backend-tier-grid backend-primary-model">
                    <label><span>Primary model</span><select className="setting-select" value={draft.routing.primaryModelId} onChange={(event) => setDraft({ ...draft, routing: { ...draft.routing, primaryModelId: event.target.value } })}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                  </div>
                  {draft.routing.mode === "advanced" && (
                    <div className="backend-tier-grid">
                      {(["fable", "opus", "sonnet", "haiku"] as const).map((tier) => (
                        <label key={tier}><span>{tier[0].toUpperCase() + tier.slice(1)}</span><select className="setting-select" value={draft.routing.mode === "advanced" ? draft.routing.tierModels[tier] : ""} onChange={(event) => {
                          if (draft.routing.mode !== "advanced") return;
                          setDraft({ ...draft, routing: { ...draft.routing, tierModels: { ...draft.routing.tierModels, [tier]: event.target.value } } });
                        }}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                      ))}
                      <label><span>Subagents</span><select className="setting-select" value={draft.routing.subagentModelId} onChange={(event) => {
                        if (draft.routing.mode !== "advanced") return;
                        setDraft({ ...draft, routing: { ...draft.routing, subagentModelId: event.target.value } });
                      }}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                      <label><span>Compaction</span><select className="setting-select" value="unavailable" disabled><option value="unavailable">Unavailable in Claude harness override</option></select></label>
                    </div>
                  )}
                </div>
              </fieldset>
              <div className="backend-editor-actions">
                <button type="button" className="secondary-button" onClick={cancelEditing}>Cancel</button>
                <button type="button" className="primary-button" aria-disabled={disabled || busyNow || undefined} onClick={() => { if (!disabled && !busyNow) void create(); }}>{busy === "create" ? "Creating…" : busy === "save" ? "Saving…" : editingId ? "Save configuration" : "Create profile"}</button>
              </div>
            </>
          ) : selected && detail ? (
            <>
              <div className="backend-profile-header">
                <span className="backend-profile-header-copy">
                  <strong>{selected.displayName}</strong>
                  <BackendProfileState profile={selected} />
                  <small>{harnessLabel(selected)} · {selected.models.map(({ displayName }) => displayName).join(", ")}</small>
                </span>
                {selected.preset !== "native" && (
                  <button type="button" className="secondary-button" aria-disabled={disabled || busyNow || undefined} onClick={() => { if (!disabled && !busyNow) beginEdit(detail); }}>Edit configuration</button>
                )}
              </div>

              <div className="backend-profile-facts">
                <div className="backend-fact">
                  <span>Endpoint</span>
                  <span title={detail.baseUrl ?? undefined}>{selected.endpointHost ?? "Managed by the harness"}</span>
                </div>
                <div className="backend-fact">
                  <span>Protocol</span>
                  <span>{protocolLabel(selected.protocol)}</span>
                </div>
              </div>

              <div className="setting-row backend-credential-row">
                <SettingCopy title="Credential" description={credentialDescription(selected)} />
                {selected.preset !== "native" && selected.authenticationMode !== "none" && (
                  <span className="backend-credential-control">
                    <input className="setting-input" type="password" aria-label="Backend credential" value={secret} autoComplete="new-password" autoFocus={selected.id === initialProfileId && selected.authState !== "configured"} placeholder={selected.authState === "configured" ? "Replace credential" : "Add credential"} onChange={(event) => setCredentialDraft({
                      profileId: selected.id,
                      configurationRevision: selected.configurationRevision,
                      value: event.target.value,
                    })} />
                    <span className="backend-credential-actions">
                      <button type="button" className="secondary-button" disabled={!secret.trim()} aria-disabled={disabled || busyNow || undefined} onClick={() => {
                        if (disabled || busyNow) return;
                        const pending = credentialDraft;
                        if (
                          !pending
                          || pending.profileId !== selected.id
                          || pending.configurationRevision
                            !== selected.configurationRevision
                        ) {
                          setCredentialDraft(null);
                          return;
                        }
                        void run(
                          "credential",
                          async () => {
                            const value = await onSetCredential(
                              pending.profileId,
                              pending.value,
                            );
                            setCredentialDraft((current) =>
                              current === pending ? null : current);
                            return value;
                          },
                          () => selectedAuthorityRef.current.configurationRevision
                            === pending.configurationRevision,
                        );
                      }}>{busy === "credential" ? "Saving…" : selected.authState === "configured" ? "Replace" : "Add"}</button>
                      {selected.authState === "configured" && (
                        <IconButton label="Clear backend credential" aria-disabled={disabled || busyNow || undefined} onClick={() => { if (disabled || busyNow) return; setCredentialDraft(null); void run("clear-credential", () => onClearCredential(selected.id)); }}><Trash2 size={14} aria-hidden="true" /></IconButton>
                      )}
                    </span>
                  </span>
                )}
              </div>

              <div className="setting-row backend-connection-row">
                <SettingCopy title="Connection" description={connectionLabel(busy === "probe" ? "testing" : selected.connectionState)} />
                {selected.preset !== "native" && (
                  <button type="button" className="secondary-button" aria-disabled={disabled || busyNow || selected.authState === "missing" || undefined} onClick={() => { if (!disabled && !busyNow && selected.authState !== "missing") void run("probe", () => onProbe(selected.id, selected.models[0]!.id)); }}>{busy === "probe" ? "Testing…" : "Test connection"}</button>
                )}
              </div>

              <div className="setting-row backend-compatibility-row">
                <SettingCopy title="Compatibility" description={selected.compatibility.reason ?? undefined} />
                <span className="backend-fact-value">{statusLabel(selected)}</span>
              </div>

              {selected.preset !== "native" && (
                <div className="setting-row">
                  <SettingCopy title="Use this backend" description="Custom profiles need compatibility evidence before they can be used." />
                  <Switch label="Use this backend" checked={selected.enabled} inactive={disabled || busyNow} onChange={(enabled) => { void run("enable", () => onUpdate(selected.id, { enabled })); }} />
                </div>
              )}

              <p className="backend-subheading" id={`${selected.id}-models`}>Models</p>
              <ul className="backend-model-list" aria-labelledby={`${selected.id}-models`}>
                {selected.models.map((model) => (
                  <li key={model.id}>
                    <span><strong>{model.displayName}</strong><code>{model.id}</code></span>
                    <small>{formattedContext(model.contextWindowTokens)} context · {model.reasoningOptions.length > 0 ? model.reasoningOptions.map(({ label }) => label).join(", ") : "Reasoning unknown"}</small>
                  </li>
                ))}
              </ul>

              <SettingDisclosure summary="Details" className="backend-profile-details">
                <ul className="backend-capability-list" aria-label={`${selected.displayName} capabilities`}>
                  {capabilities.map((capability) => (
                    <li key={capability.id} title={capability.detail ?? undefined}>
                      <span>{capabilityLabel(capability.id)}</span>
                      <span>{CAPABILITY_STATE_LABELS[capability.state]} · {PROVENANCE_LABELS[capability.provenance]}</span>
                    </li>
                  ))}
                  <li><span>Revision</span><span>{selected.configurationRevision}</span></li>
                </ul>
                {capabilities.length === 0 && <p className="backend-capability-note">Capabilities are unknown until the connection is tested.</p>}
              </SettingDisclosure>

              {selected.canDelete && (
                <div className="setting-row backend-danger-zone">
                  <SettingCopy title="Delete profile" description="Past turns keep this profile’s display name. Its credential is forgotten." />
                  {deleteConfirm ? (
                    <span className="backend-danger-actions">
                      <button ref={deleteCancelRef} type="button" className="secondary-button" onClick={() => { restoreDeleteFocusRef.current = true; setDeleteConfirm(false); }}>Cancel</button>
                      <button type="button" className="secondary-button is-danger" aria-disabled={disabled || busyNow || undefined} onClick={() => {
                        if (disabled || busyNow) return;
                        void run("delete", async (isCurrent) => {
                          setCredentialDraft(null);
                          await onDelete(selected.id);
                          if (!isCurrent()) return;
                          setSelectedId(profiles.find(({ id }) => id !== selected.id)?.id ?? null);
                          setDetail(null);
                        });
                      }}>Delete permanently</button>
                    </span>
                  ) : <button ref={deleteRef} type="button" className="secondary-button" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} aria-hidden="true" />Delete</button>}
                </div>
              )}
            </>
          ) : (
            <p className="backend-editor-loading" aria-busy="true"><LoadingMark label="Loading backend details" />Loading backend details…</p>
          )}

          {error && <p className="backend-form-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        </div>
      </div>
    </section>
  );
}
