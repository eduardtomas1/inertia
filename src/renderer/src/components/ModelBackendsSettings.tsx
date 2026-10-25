import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { isApiKeyBackendPresetId, type ApiKeyBackendPresetId } from "@shared/backend-presets";
import type {
  ModelBackendProfileDetail,
  ModelBackendProfileView,
  ProviderId,
  ProviderInfo,
} from "@shared/contracts";
import type { ProviderAuthMethod } from "@shared/provider";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import {
  API_KEY_PRESET_FOR_PROVIDER,
  BACKEND_SETTINGS_PROVIDER_NAMES,
  BACKEND_SETTINGS_PROVIDER_ORDER,
  keyProfilesForProvider,
} from "../utils/backendSettingsModel";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { AddApiKeyDialog } from "./backend-settings/AddApiKeyDialog";
import { BackendKeyRow } from "./backend-settings/BackendKeyRow";
import { CustomBackendCreator } from "./backend-settings/BackendProfileForms";
import { ProviderAccountRow } from "./backend-settings/ProviderAccountRow";
import type { BackendProfileActions } from "./backend-settings/backendSettingsActions";
import type {
  BackendSetupResume,
  BackendSetupStatus,
  BackendSetupStatusListener,
} from "./backend-settings/useBackendSetup";
import "./ModelBackendsSettings.css";

export type ModelBackendsSettingsProps = BackendProfileActions & {
  profiles: ModelBackendProfileView[];
  providers: ProviderInfo[];
  providerIdentityLabels?: ProviderIdentityLabels;
  initialProfileId?: string;
  initialProfilePanel?: "key" | "models";
  disabled: boolean;
  onConnectProvider: (providerId: ProviderId, method?: ProviderAuthMethod) => void;
  onRefreshProvider: (providerId?: ProviderId) => void;
};

function keyListNote(providerId: ProviderId): string | null {
  if (providerId === "opencode") {
    return "OpenCode keeps its own keys. Use Sign in through OpenCode to run opencode auth login.";
  }
  if (providerId === "cursor") return "Account only, with usage not reported.";
  if (providerId === "antigravity" && !API_KEY_PRESET_FOR_PROVIDER.antigravity) return "Account only.";
  return null;
}

function emptyKeyCopy(providerId: ProviderId): string {
  if (providerId === "claude") return "No API keys yet. Add an Anthropic API key to use your API credits.";
  if (providerId === "codex") return "No API keys yet. Add an OpenAI API key to use your API credits.";
  if (providerId === "antigravity") return "No API keys yet. Add a Gemini API key to use your API credits.";
  return "No API keys yet.";
}

const ANTIGRAVITY_POLICY_NOTE = API_KEY_PRESET_FOR_PROVIDER.antigravity
  ? "Google says wrapping agy in another app isn't supported on consumer plans. Use a Gemini API key."
  : "Google says wrapping agy in another app isn't supported on consumer plans.";

function ProviderAccessCard({
  providerId,
  provider,
  profiles,
  identityLabel,
  actions,
  disabled,
  initialProfileId,
  initialProfilePanel,
  onConnect,
  onRefresh,
  onAddKey,
  setups,
  onSetupStatus,
  onResumeSetup,
}: {
  providerId: ProviderId;
  provider: ProviderInfo | undefined;
  profiles: readonly ModelBackendProfileView[];
  identityLabel: string | undefined;
  actions: BackendProfileActions;
  disabled: boolean;
  initialProfileId?: string;
  initialProfilePanel?: "key" | "models";
  onConnect: (providerId: ProviderId, method?: ProviderAuthMethod) => void;
  onRefresh: (providerId: ProviderId) => void;
  onAddKey: (preset: ApiKeyBackendPresetId) => void;
  setups: ReadonlyMap<string, BackendSetupStatus>;
  onSetupStatus: BackendSetupStatusListener;
  onResumeSetup: (profileId: string) => void;
}): React.JSX.Element {
  const headingId = useId();
  const keysHeadingId = useId();
  const name = BACKEND_SETTINGS_PROVIDER_NAMES[providerId];
  const preset = API_KEY_PRESET_FOR_PROVIDER[providerId];
  const note = keyListNote(providerId);
  return (
    <section className="backend-provider-card" aria-labelledby={headingId} data-provider-card={providerId}>
      <header className="backend-provider-card-header">
        <ProviderBrandIcon providerId={providerId} decorative size={16} />
        <h4 id={headingId}>{name}</h4>
      </header>
      <ProviderAccountRow
        providerId={providerId}
        providerName={name}
        provider={provider}
        identityLabel={identityLabel}
        disabled={disabled}
        onConnect={onConnect}
        onRefresh={onRefresh}
      />
      {providerId === "antigravity" && (
        <p className="backend-provider-policy">{ANTIGRAVITY_POLICY_NOTE}</p>
      )}
      <div className="backend-key-list">
        <div className="backend-key-list-heading">
          <strong id={keysHeadingId}>API keys</strong>
          {preset && (
            <button
              type="button"
              className="secondary-button"
              aria-label={`Add API key for ${name}`}
              aria-disabled={disabled || undefined}
              onClick={() => { if (!disabled) onAddKey(preset); }}
            >
              <Plus size={14} aria-hidden="true" />Add API key
            </button>
          )}
        </div>
        {profiles.length > 0 ? (
          <ul className="backend-key-rows" aria-labelledby={keysHeadingId}>
            {profiles.map((profile) => (
              <BackendKeyRow
                key={profile.id}
                profile={profile}
                actions={actions}
                disabled={disabled}
                initiallyOpenKey={profile.id === initialProfileId
                  && (initialProfilePanel === "key" || (!initialProfilePanel && profile.authState !== "configured"))}
                initiallyOpenModels={profile.id === initialProfileId && initialProfilePanel === "models"}
                setupStatus={setups.get(profile.id) ?? null}
                onSetupStatus={onSetupStatus}
                onResumeSetup={() => onResumeSetup(profile.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="backend-key-empty">{note ?? emptyKeyCopy(providerId)}</p>
        )}
        {profiles.length > 0 && note && <p className="backend-key-empty">{note}</p>}
      </div>
    </section>
  );
}

export function ModelBackendsSettings({
  profiles,
  providers,
  providerIdentityLabels = {},
  initialProfileId,
  initialProfilePanel,
  disabled,
  onConnectProvider,
  onRefreshProvider,
  onLoadDetail,
  onCreate,
  onUpdate,
  onSetCredential,
  onClearCredential,
  onProbe,
  onDiscoverModels,
  onDelete,
}: ModelBackendsSettingsProps): React.JSX.Element {
  const [dialogPreset, setDialogPreset] = useState<ApiKeyBackendPresetId | null>(null);
  const [dialogResume, setDialogResume] = useState<BackendSetupResume | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [setups, setSetups] = useState<ReadonlyMap<string, { status: BackendSetupStatus; profile: ModelBackendProfileView }>>(
    () => new Map(),
  );
  const onSetupStatus = useCallback<BackendSetupStatusListener>((profile, status) => {
    setSetups((current) => {
      const next = new Map(current);
      if (status.state === "done") next.delete(profile.id);
      else next.set(profile.id, { status, profile });
      return next;
    });
  }, []);
  const setupStatuses = useMemo(
    () => new Map([...setups].map(([id, { status }]) => [id, status])),
    [setups],
  );
  const shownProfiles = useMemo(() => {
    const known = new Set(profiles.map(({ id }) => id));
    return [
      ...profiles,
      ...[...setups.values()].flatMap(({ profile }) => known.has(profile.id) ? [] : [profile]),
    ];
  }, [profiles, setups]);
  const customButtonRef = useRef<HTMLButtonElement>(null);
  const restoreCustomFocusRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const actions = useMemo<BackendProfileActions>(() => ({
    onLoadDetail,
    onCreate,
    onUpdate,
    onSetCredential,
    onClearCredential,
    onProbe,
    onDiscoverModels,
    onDelete,
  }), [onClearCredential, onCreate, onDelete, onDiscoverModels, onLoadDetail, onProbe, onSetCredential, onUpdate]);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  useLayoutEffect(() => {
    if (customOpen || !restoreCustomFocusRef.current) return;
    restoreCustomFocusRef.current = false;
    customButtonRef.current?.focus();
  }, [customOpen]);
  useEffect(() => {
    if (!initialProfileId) return;
    const target = [...(sectionRef.current?.querySelectorAll<HTMLElement>("[data-profile-id]") ?? [])]
      .find((element) => element.dataset.profileId === initialProfileId);
    target?.scrollIntoView?.({ block: "nearest" });
  }, [initialProfileId]);
  return (
    <section
      ref={sectionRef}
      className="settings-card backend-settings"
      aria-labelledby="backends-heading"
      data-setting-id="model-backends"
    >
      <div className="settings-card-heading backend-settings-toolbar">
        <span>
          <h3 id="backends-heading">Accounts and API keys</h3>
        </span>
      </div>
      <p className="backend-settings-intro">
        A chat uses one route at a time: the account, or an API key you choose in the model chooser. You can keep both set up.
      </p>
      <div className="backend-provider-cards">
        {BACKEND_SETTINGS_PROVIDER_ORDER.map((providerId) => (
          <ProviderAccessCard
            key={providerId}
            providerId={providerId}
            provider={providerById.get(providerId)}
            profiles={keyProfilesForProvider(shownProfiles, providerId)}
            identityLabel={providerIdentityLabels[providerId]}
            actions={actions}
            disabled={disabled}
            initialProfileId={initialProfileId}
            initialProfilePanel={initialProfilePanel}
            onConnect={onConnectProvider}
            onRefresh={onRefreshProvider}
            onAddKey={setDialogPreset}
            setups={setupStatuses}
            onSetupStatus={onSetupStatus}
            onResumeSetup={(profileId) => {
              const entry = setups.get(profileId);
              if (entry?.status.state !== "paused" || !isApiKeyBackendPresetId(entry.profile.preset)) return;
              setDialogResume({
                profile: entry.profile as ModelBackendProfileDetail,
                models: entry.status.models,
              });
              setDialogPreset(entry.profile.preset);
            }}
          />
        ))}
      </div>

      <div className="backend-custom-section">
        <div className="backend-key-list-heading">
          <span className="backend-custom-copy">
            <strong>Advanced</strong>
            <small>Route chats through your own Anthropic- or OpenAI-compatible endpoint. Custom backends appear under Claude Code or Codex above.</small>
          </span>
          {!customOpen && (
            <button
              ref={customButtonRef}
              type="button"
              className="secondary-button"
              aria-disabled={disabled || undefined}
              onClick={() => { if (!disabled) setCustomOpen(true); }}
            >
              <Plus size={14} aria-hidden="true" />Add custom backend…
            </button>
          )}
        </div>
        {customOpen && (
          <CustomBackendCreator
            actions={actions}
            disabled={disabled}
            onStatus={onSetupStatus}
            onCancel={() => {
              restoreCustomFocusRef.current = true;
              setCustomOpen(false);
            }}
            onDone={() => {
              restoreCustomFocusRef.current = true;
              setCustomOpen(false);
            }}
          />
        )}
      </div>

      {dialogPreset && (
        <AddApiKeyDialog
          preset={dialogPreset}
          actions={actions}
          onStatus={onSetupStatus}
          {...(dialogResume ? { resume: dialogResume } : {})}
          onClose={() => {
            setDialogPreset(null);
            setDialogResume(null);
          }}
        />
      )}
    </section>
  );
}
