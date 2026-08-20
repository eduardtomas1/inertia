import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CloudCog,
  KeyRound,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  type BackendModelDefinition,
  type ModelBackendDefault,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelBackendProfileView,
  type ModelSelection,
  type Project,
} from "@shared/contracts";
import { modelSelectionSchema } from "@shared/model-routing";
import {
  backendProfileSemanticUpdate,
  backendProfileIsReady,
  setBackendDraftAdvancedRouting,
  updateBackendDraftModel,
} from "../utils/backendProfileDraft";
import { Switch } from "./ui";

type ModelBackendsSettingsProps = {
  profiles: ModelBackendProfileView[];
  initialProfileId?: string;
  defaults: ModelBackendDefault[];
  projects: Project[];
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
  onSetDefault: (
    projectId: string | null,
    selection: ModelSelection,
  ) => Promise<void>;
  onClearDefault: (projectId: string | null) => Promise<void>;
};

const emptyCapabilities: BackendModelDefinition["capabilities"] = [];
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

function identityLabel(profile: ModelBackendProfileView): string {
  const harness = profile.harnessId.startsWith("claude")
    ? "Claude"
    : profile.harnessId.startsWith("codex")
      ? "Codex"
      : profile.harnessId.startsWith("cursor")
        ? "Cursor"
        : profile.harnessId.startsWith("kimi")
          ? "Kimi Code"
          : "OpenCode";
  return `${harness} harness · ${profile.displayName}`;
}

function profileSelection(
  profile: ModelBackendProfileView,
  modelId: string,
  reasoningEffort: string | null = null,
): ModelSelection {
  const model = profile.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error("That model is unavailable.");
  return modelSelectionSchema.parse({
    harnessId: profile.harnessId,
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId: model.id,
    alias: profile.preset === "kimi-code"
      ? null
      : model.displayName === model.id ? null : model.displayName,
    reasoningEffort,
    contextWindowOverride: model.contextWindowTokens,
    providerOptions: {},
    capabilities: model.capabilities,
    backendConfigurationRevision: profile.configurationRevision,
  });
}

function statusLabel(profile: ModelBackendProfileView): string {
  if (!profile.enabled) return "Disabled";
  if (profile.compatibility.state === "verified") return "Verified";
  if (profile.compatibility.state === "partially-compatible") return "Partial";
  if (profile.compatibility.state === "user-declared") return "User declared";
  if (profile.compatibility.state === "unavailable") return "Unavailable";
  return "Unknown";
}

function formattedContext(tokens: number | null): string {
  if (!tokens) return "Unknown";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

interface BackendCredentialDraft {
  profileId: string;
  configurationRevision: number;
  value: string;
}

export function ModelBackendsSettings({
  profiles,
  initialProfileId,
  defaults,
  projects,
  disabled,
  onLoadDetail,
  onCreate,
  onUpdate,
  onSetCredential,
  onClearCredential,
  onProbe,
  onDelete,
  onSetDefault,
  onClearDefault,
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
  const selectionEpochRef = useRef(0);
  const [projectDefaultProjectId, setProjectDefaultProjectId] = useState(
    projects[0]?.id ?? "",
  );
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
  const modelChoices = useMemo(() =>
    profiles.flatMap((profile) => profile.enabled
      && profile.compatibility.state !== "unknown"
      && profile.compatibility.state !== "unavailable"
      ? profile.models.map((model) => ({
          key: `${profile.id}\0${model.id}`,
          profile,
          model,
        }))
      : []), [profiles]);
  const globalDefault = defaults.find(({ scope }) => scope === "global") ?? null;
  const projectDefault = defaults.find(({ scope, projectId }) =>
    scope === "project" && projectId === projectDefaultProjectId) ?? null;

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

  const run = async (
    key: string,
    operation: () => Promise<ModelBackendProfileDetail | void>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const value = await operation();
      if (value && isCurrent()) {
        setDetail(value);
        setSelectedId(value.id);
      }
    } catch (reason) {
      if (isCurrent()) {
        setError(reason instanceof Error ? reason.message : "The backend change could not be saved.");
      }
    } finally {
      setBusy(null);
    }
  };

  const create = async (): Promise<void> => {
    if (!draft) return;
    await run(editingId ? "save" : "create", async () => {
      const value = editingId
        ? await onUpdate(
            editingId,
            originalDraft
              ? backendProfileSemanticUpdate(originalDraft, draft)
              : draft,
          )
        : await onCreate(draft);
      setDraft(null);
      setOriginalDraft(null);
      setEditingId(null);
      return value;
    });
  };

  const beginEdit = (profile: ModelBackendProfileDetail): void => {
    if (profile.preset === "native") return;
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

  const setDefault = async (
    projectId: string | null,
    key: string,
  ): Promise<void> => {
    if (!key) {
      await onClearDefault(projectId);
      return;
    }
    const choice = modelChoices.find((candidate) => candidate.key === key);
    if (!choice) return;
    await onSetDefault(
      projectId,
      profileSelection(choice.profile, choice.model.id),
    );
  };

  return (
    <section className="backend-settings" aria-label="Model backend profiles">
      <div className="backend-settings-toolbar">
        <span>
          <span className="welcome-kicker">Harness-aware routing</span>
          <h3>Connections</h3>
          <p>Keep the agent harness, backend profile, model, and reasoning as separate choices.</p>
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || Boolean(busy)}
          onClick={() => {
            setCredentialDraft(null);
            setDraft(defaultDraft());
            setOriginalDraft(null);
            setEditingId(null);
            setDetail(null);
            setError(null);
          }}
        >
          <Plus size={14} />New profile
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
                selectionEpochRef.current += 1;
                setCredentialDraft(null);
                setDraft(null);
                setOriginalDraft(null);
                setEditingId(null);
                setSelectedId(profile.id);
                setError(null);
              }}
              key={profile.id}
              title={identityLabel(profile)}
            >
              <span className="backend-profile-icon">
                {profile.harnessId.startsWith("claude")
                  ? <Bot size={15} />
                  : <CloudCog size={15} />}
              </span>
              <span>
                <strong>{profile.displayName}</strong>
                <small>{profile.endpointHost ?? (profile.preset === "native" ? "Harness managed" : "Endpoint hidden")}</small>
              </span>
              <i className={clsx(
                "backend-profile-dot",
                backendProfileIsReady(profile) && "is-ready",
              )} />
            </button>
          ))}
        </aside>

        <div className="backend-profile-editor">
          {draft ? (
            <>
              <div className="backend-editor-heading">
                <span className="backend-profile-icon"><Plus size={16} /></span>
                <span><strong>{editingId ? "Edit backend configuration" : "Create a backend profile"}</strong><small>{editingId ? "Saving execution changes increments the profile revision and requires a fresh compatibility test." : "Custom endpoints stay isolated from native provider configuration."}</small></span>
                <button type="button" className="icon-button" aria-label="Cancel profile editing" onClick={() => { setDraft(null); setOriginalDraft(null); setEditingId(null); }}><X size={15} /></button>
              </div>

              <div className="backend-form-section">
                <span className="backend-section-label">1 · Harness</span>
                <div className="backend-choice-grid">
                  <button type="button" disabled={editingBuiltIn} className={clsx(draft.harnessId === "claude-agent-sdk" && "is-active")} onClick={() => setHarness("claude-agent-sdk")}><Bot size={16} /><span><strong>Claude harness</strong><small>Anthropic Messages-compatible</small></span>{draft.harnessId === "claude-agent-sdk" && <Check size={14} />}</button>
                  <button type="button" disabled={editingBuiltIn} className={clsx(draft.harnessId === "codex-app-server" && "is-active")} onClick={() => setHarness("codex-app-server")}><CloudCog size={16} /><span><strong>Codex harness</strong><small>OpenAI Responses-compatible</small></span>{draft.harnessId === "codex-app-server" && <Check size={14} />}</button>
                </div>
              </div>

              <div className="backend-form-section">
                <span className="backend-section-label">2 · Backend profile</span>
                <div className="settings-form-grid">
                  <label><span>Name</span><input disabled={editingBuiltIn} value={draft.displayName} maxLength={200} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
                  <label><span>Authentication</span><select disabled={editingBuiltIn} value={draft.authenticationMode} onChange={(event) => setDraft({ ...draft, authenticationMode: event.target.value as ModelBackendProfileDraft["authenticationMode"] })}><option value="api-key">API key</option><option value="bearer-token">Bearer token</option><option value="none">No credential</option></select></label>
                  <label className="backend-base-url-field"><span>Base URL</span><input disabled={editingBuiltIn} value={draft.baseUrl} maxLength={2048} spellCheck={false} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
                </div>
                <label className="backend-inline-toggle"><Switch label="Allow localhost HTTP" checked={draft.allowInsecureLocalhost} disabled={editingBuiltIn} onChange={(allowInsecureLocalhost) => setDraft({ ...draft, allowInsecureLocalhost })} /><span><strong>Allow localhost HTTP</strong><small>{editingBuiltIn ? "Built-in connection settings are fixed; model mappings remain editable." : "Advanced local-development exception only. Other endpoints must use HTTPS."}</small></span></label>
              </div>

              <div className="backend-form-section">
                <div className="backend-model-editor-heading">
                  <span className="backend-section-label">3 · Models</span>
                  <button type="button" className="secondary-button" disabled={editingBuiltIn} onClick={addDraftModel}><Plus size={13} />Add model</button>
                </div>
                <div className="backend-editable-models">
                  {draft.models.map((model, index) => (
                    <div className="backend-editable-model" key={`${index}-${model.id}`}>
                      <label><span>Model ID</span><input disabled={editingBuiltIn} value={model.id} maxLength={500} spellCheck={false} onChange={(event) => updateDraftModel(index, "id", event.target.value)} /></label>
                      <label><span>Display name</span><input disabled={editingBuiltIn} value={model.displayName} maxLength={200} onChange={(event) => updateDraftModel(index, "displayName", event.target.value)} /></label>
                      <label><span>Context tokens</span><input disabled={editingBuiltIn} type="number" min={8192} max={100000000} value={model.contextWindowTokens ?? ""} placeholder="Unknown" onChange={(event) => updateDraftModel(index, "contextWindowTokens", event.target.value)} /></label>
                      <button type="button" className="icon-button" aria-label={`Remove ${model.displayName}`} disabled={editingBuiltIn || draft.models.length <= 1} onClick={() => removeDraftModel(index)}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                {draft.harnessId === "claude-agent-sdk" && (
                  <div className="backend-routing-mode">
                    <span><strong>Model mapping</strong><small>Simple routes every Claude tier and subagent to the primary model. Advanced mappings can choose any configured model.</small></span>
                    <div role="radiogroup" aria-label="Model mapping">
                      <button type="button" className={!advanced ? "is-active" : undefined} onClick={() => setAdvancedRouting(false)}>Simple</button>
                      <button type="button" className={advanced ? "is-active" : undefined} onClick={() => setAdvancedRouting(true)}>Advanced</button>
                    </div>
                  </div>
                )}
                <div className="backend-tier-grid backend-primary-model">
                  <label><span>Primary model</span><select value={draft.routing.primaryModelId} onChange={(event) => setDraft({ ...draft, routing: { ...draft.routing, primaryModelId: event.target.value } })}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                </div>
                {draft.routing.mode === "advanced" && (
                  <div className="backend-tier-grid">
                    {(["fable", "opus", "sonnet", "haiku"] as const).map((tier) => (
                      <label key={tier}><span>{tier[0].toUpperCase() + tier.slice(1)}</span><select value={draft.routing.mode === "advanced" ? draft.routing.tierModels[tier] : ""} onChange={(event) => {
                        if (draft.routing.mode !== "advanced") return;
                        setDraft({ ...draft, routing: { ...draft.routing, tierModels: { ...draft.routing.tierModels, [tier]: event.target.value } } });
                      }}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                    ))}
                    <label><span>Subagents</span><select value={draft.routing.subagentModelId} onChange={(event) => {
                      if (draft.routing.mode !== "advanced") return;
                      setDraft({ ...draft, routing: { ...draft.routing, subagentModelId: event.target.value } });
                    }}>{draft.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.id}</option>)}</select></label>
                    <label><span>Compaction</span><select value="unavailable" disabled><option value="unavailable">Unavailable in Claude harness override</option></select></label>
                  </div>
                )}
              </div>

              <div className="backend-editor-actions">
                <button type="button" className="secondary-button" onClick={() => { setDraft(null); setOriginalDraft(null); setEditingId(null); }}>Cancel</button>
                <button type="button" className="primary-button" disabled={disabled || Boolean(busy)} onClick={() => { void create(); }}>{busy === "create" ? "Creating…" : busy === "save" ? "Saving…" : editingId ? "Save configuration" : "Create profile"}</button>
              </div>
            </>
          ) : selected && detail ? (
            <>
              <div className="backend-editor-heading">
                <span className="backend-profile-icon"><ServerCog size={16} /></span>
                <span>
                  <strong title={identityLabel(selected)}>{identityLabel(selected)}</strong>
                  <small>{selected.models.map(({ displayName }) => displayName).join(", ")}</small>
                </span>
                {selected.source === "custom" && <em>Custom endpoint</em>}
                {selected.preset !== "native" && (
                  <button type="button" className="secondary-button backend-edit-profile" disabled={disabled || Boolean(busy)} onClick={() => beginEdit(detail)}><ServerCog size={14} />Edit configuration</button>
                )}
              </div>

              <div className="backend-status-strip" aria-label="Backend status">
                <span><KeyRound size={13} /><small>Authentication</small><strong>{selected.authState.replaceAll("-", " ")}</strong></span>
                <ChevronRight size={12} />
                <span><ServerCog size={13} /><small>Connection</small><strong>{selected.connectionState.replaceAll("-", " ")}</strong></span>
                <ChevronRight size={12} />
                <span><ShieldCheck size={13} /><small>Compatibility</small><strong>{statusLabel(selected)}</strong></span>
              </div>

              <div className="backend-identity-card">
                <span><small>Endpoint</small><strong title={detail.baseUrl ?? undefined}>{selected.endpointHost ?? "Managed by harness"}</strong></span>
                <span><small>Protocol</small><strong>{selected.protocol === "anthropic-messages" ? "Anthropic Messages" : selected.protocol === "openai-responses" ? "OpenAI Responses" : selected.protocol}</strong></span>
                <span><small>Context</small><strong>{formattedContext(selected.models[0]?.contextWindowTokens ?? null)}</strong></span>
                <span><small>Revision</small><strong>{selected.configurationRevision}</strong></span>
              </div>

              {selected.preset !== "native" && (
                <div className="backend-secret-row">
                  <span className="backend-profile-icon"><KeyRound size={15} /></span>
                  <span><strong>Backend credential</strong><small>{selected.authState === "configured" ? "Stored in your operating system’s secure vault." : "No usable credential is available for this profile."}</small></span>
                  {selected.authenticationMode !== "none" && (
                    <input type="password" value={secret} autoComplete="new-password" autoFocus={selected.id === initialProfileId && selected.authState !== "configured"} placeholder={selected.authState === "configured" ? "Replace credential" : "Add credential"} onChange={(event) => setCredentialDraft({
                      profileId: selected.id,
                      configurationRevision: selected.configurationRevision,
                      value: event.target.value,
                    })} />
                  )}
                  {selected.authenticationMode !== "none" && (
                    <button type="button" className="secondary-button" disabled={!secret.trim() || disabled || Boolean(busy)} onClick={() => {
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
                      const selectionEpoch = selectionEpochRef.current;
                      const responseIsCurrent = (): boolean => {
                        const authority = selectedAuthorityRef.current;
                        return (
                          selectionEpochRef.current === selectionEpoch
                          && authority.profileId === pending.profileId
                          && authority.configurationRevision
                            === pending.configurationRevision
                        );
                      };
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
                        responseIsCurrent,
                      );
                    }}>{busy === "credential" ? "Saving…" : selected.authState === "configured" ? "Replace" : "Add"}</button>
                  )}
                  {selected.authState === "configured" && (
                    <button type="button" className="icon-button" aria-label="Clear backend credential" disabled={disabled || Boolean(busy)} onClick={() => { setCredentialDraft(null); void run("clear-credential", () => onClearCredential(selected.id)); }}><Trash2 size={14} /></button>
                  )}
                </div>
              )}

              <div className="backend-model-card">
                <span className="backend-section-label">Models and mappings</span>
                {selected.models.map((model) => (
                  <div className="backend-model-row" key={model.id}>
                    <span><strong>{model.displayName}</strong><small title={model.id}>{model.id}</small></span>
                    <span><small>Context</small><strong>{formattedContext(model.contextWindowTokens)}</strong></span>
                    <span><small>Reasoning</small><strong>{model.reasoningOptions.length > 0 ? model.reasoningOptions.map(({ label }) => label).join(", ") : "Unknown"}</strong></span>
                  </div>
                ))}
                <div className="backend-capability-list">
                  {(selected.latestProbe?.capabilities ?? selected.capabilityHints).map((capability) => (
                    <span className={clsx(`is-${capability.state}`)} title={capability.detail ?? undefined} key={capability.id}><i />{capability.id.replaceAll("-", " ")}<small>{capability.provenance}</small></span>
                  ))}
                  {(selected.latestProbe?.capabilities.length ?? selected.capabilityHints.length) === 0 && <p>Capabilities are unknown until the connection is tested.</p>}
                </div>
              </div>

              {selected.preset !== "native" && (
                <div className="backend-profile-controls">
                  <label><Switch label={`Enable ${selected.displayName}`} checked={selected.enabled} disabled={disabled || Boolean(busy)} onChange={(enabled) => { void run("enable", () => onUpdate(selected.id, { enabled })); }} /><span><strong>Enabled</strong><small>Custom profiles require exact compatibility evidence before enabling.</small></span></label>
                  <button type="button" className="secondary-button" disabled={disabled || Boolean(busy) || selected.authState === "missing"} onClick={() => { void run("probe", () => onProbe(selected.id, selected.models[0]!.id)); }}><RefreshCw size={14} className={busy === "probe" ? "is-spinning" : undefined} />{busy === "probe" ? "Testing…" : "Test connection"}</button>
                </div>
              )}

              {selected.compatibility.reason && (
                <p className={clsx("backend-policy-note", selected.compatibility.state === "unavailable" && "is-warning")}>
                  {selected.compatibility.state === "unavailable" ? <CircleAlert size={14} /> : <ShieldCheck size={14} />}
                  <span><strong>{statusLabel(selected)}</strong><small>{selected.compatibility.reason}</small></span>
                </p>
              )}

              {selected.canDelete && (
                <div className="backend-danger-zone">
                  <span><strong>Delete profile</strong><small>Historical turns keep this profile’s safe display identity. Its credential is forgotten.</small></span>
                  {deleteConfirm ? (
                    <span><button type="button" className="secondary-button" onClick={() => setDeleteConfirm(false)}>Cancel</button><button type="button" className="danger-button" disabled={disabled || Boolean(busy)} onClick={() => { void run("delete", async () => {
                      setCredentialDraft(null);
                      await onDelete(selected.id);
                      setSelectedId(profiles.find(({ id }) => id !== selected.id)?.id ?? null);
                      setDetail(null);
                    }); }}>Delete permanently</button></span>
                  ) : <button type="button" className="secondary-button" onClick={() => setDeleteConfirm(true)}><Trash2 size={14} />Delete</button>}
                </div>
              )}
            </>
          ) : (
            <div className="backend-editor-loading"><RefreshCw size={17} className="is-spinning" /><span>Loading backend details…</span></div>
          )}

          {error && <p className="backend-form-error" role="alert"><CircleAlert size={14} />{error}</p>}
        </div>
      </div>

      <section className="settings-card backend-defaults-card" aria-labelledby="backend-defaults-heading">
        <div className="settings-card-heading"><div><Bot size={18} /></div><span><h3 id="backend-defaults-heading">New chat defaults</h3><p>Choose a full harness, backend, and model identity. Project defaults override the global choice.</p></span></div>
        <div className="settings-form-grid">
          <label><span>Global default</span><select value={globalDefault ? `${globalDefault.selection.backendProfileId}\0${globalDefault.selection.modelId}` : ""} disabled={disabled} onChange={(event) => { void setDefault(null, event.target.value); }}><option value="">Use native app default</option>{modelChoices.map(({ key, profile, model }) => <option value={key} key={key}>{identityLabel(profile)} · {model.displayName}</option>)}</select></label>
          <label><span>Project</span><select value={projectDefaultProjectId} disabled={disabled || projects.length === 0} onChange={(event) => setProjectDefaultProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
          <label className="backend-project-default"><span>Project default</span><select value={projectDefault ? `${projectDefault.selection.backendProfileId}\0${projectDefault.selection.modelId}` : ""} disabled={disabled || !projectDefaultProjectId} onChange={(event) => { void setDefault(projectDefaultProjectId || null, event.target.value); }}><option value="">Use global default</option>{modelChoices.map(({ key, profile, model }) => <option value={key} key={key}>{identityLabel(profile)} · {model.displayName}</option>)}</select></label>
        </div>
      </section>
    </section>
  );
}
