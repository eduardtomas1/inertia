import type {
  AppSettings,
  ModelBackendDefault,
  ModelBackendProfileView,
  ModelSelection,
  ProviderInfo,
} from "@shared/contracts";
import { providerNativeBackendProfile } from "@shared/model-routing";
import { effectiveNewChatDefault } from "@shared/new-chat-default";
import { buildComposerModelRoutes, type ComposerModelRoute } from "../../../utils/modelChooserRoutes";
import { modelRouteIdentityKey } from "../../../utils/modelFavorites";
import { SettingSelect, type SettingOption } from "../SettingControls";
import { SettingsGroup } from "../SettingsLayout";

export type DefaultModelUpdate = Pick<AppSettings, "defaultProvider" | "defaultModel" | "defaultReasoningEffort">;

export interface NewChatDefaultsProps {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  backendDefaults: ModelBackendDefault[];
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
  onSetDefaultModel: (update: DefaultModelUpdate) => Promise<void>;
  onSetBackendDefault: (projectId: string | null, selection: ModelSelection) => Promise<void>;
}

const WORK_MODES: readonly SettingOption<AppSettings["defaultInteractionMode"]>[] = [
  { value: "build", label: "Build" },
  { value: "plan", label: "Plan" },
];
const ACCESS_MODES: readonly SettingOption<AppSettings["defaultAccessMode"]>[] = [
  { value: "supervised", label: "Supervised" },
  { value: "auto-edit", label: "Auto-accept edits" },
  { value: "full", label: "Full access" },
];
export const NEW_CHAT_LOCATIONS: readonly SettingOption<AppSettings["newThreadMode"]>[] = [
  { value: "local", label: "Current checkout" },
  { value: "worktree", label: "New worktree" },
];

function isNativeRoute(route: Pick<ComposerModelRoute, "providerId" | "backendProfileId">): boolean {
  return route.providerId !== null && route.backendProfileId === providerNativeBackendProfile(route.providerId).id;
}

function reasoningLabels(
  selection: ModelSelection,
  providers: readonly ProviderInfo[],
  profiles: readonly ModelBackendProfileView[],
): { labels: Map<string, string>; modelDefault: string | null } {
  const profile = profiles.find(({ id }) => id === selection.backendProfileId);
  const profileModel = profile?.models.find(({ id }) => id === selection.modelId);
  if (profileModel) {
    return { labels: new Map(profileModel.reasoningOptions.map(({ value, label }) => [value, label])), modelDefault: null };
  }
  const provider = providers.find(({ id }) => selection.backendProfileId === providerNativeBackendProfile(id).id);
  const model = selection.modelId === "provider-default"
    ? provider?.models.find(({ isDefault }) => isDefault) ?? provider?.models[0]
    : provider?.models.find(({ id }) => id === selection.modelId);
  return {
    labels: new Map(model?.reasoningOptions.map(({ value, label }) => [value, label]) ?? []),
    modelDefault: model?.defaultReasoningEffort || null,
  };
}

export function NewChatDefaults({
  settings,
  disabled,
  providers,
  backendProfiles,
  backendDefaults,
  onUpdate,
  onSetDefaultModel,
  onSetBackendDefault,
}: NewChatDefaultsProps): React.JSX.Element {
  const effective = effectiveNewChatDefault({ providers, backendProfiles, backendDefaults }, settings);
  const routes = buildComposerModelRoutes(providers, backendProfiles, effective.selection, settings.providerIdentityLabels);
  const effectiveKey = modelRouteIdentityKey(effective.selection);
  const effectiveRoute = routes.find(({ key }) => key === effectiveKey);
  const modelOptions: SettingOption<string>[] = [
    ...(effectiveRoute ? [] : [{ value: effectiveKey, label: `${effective.selection.alias ?? effective.selection.modelId} (unavailable)`, disabled: true }]),
    ...routes.map((route) => ({
      value: route.key,
      label: route.selectable ? route.displayName : `${route.displayName} (unavailable)`,
      disabled: !route.selectable,
      group: `${route.backendProfileName} · ${route.harnessLabel}`,
    })),
  ];
  const { labels, modelDefault } = reasoningLabels(effective.selection, providers, backendProfiles);
  const levels = effectiveRoute?.reasoningOptions ?? [];
  const reasoningOptions: SettingOption<string>[] = [
    { value: "", label: modelDefault ? `Model default (${labels.get(modelDefault) ?? modelDefault})` : "Model default" },
    ...levels.map((value) => ({ value, label: labels.get(value) ?? value })),
  ];
  const storedProvider = providers.find(({ id }) => id === settings.defaultProvider);
  const fallbackProvider = providers.find(({ id }) => id === effective.providerId);
  const nativeDefault = (providerId: DefaultModelUpdate["defaultProvider"], modelId: string, reasoning: string): Promise<void> =>
    onSetDefaultModel({
      defaultProvider: providerId,
      defaultModel: modelId === "provider-default" ? "" : modelId,
      defaultReasoningEffort: reasoning,
    });
  const chooseModel = async (key: string): Promise<void> => {
    const route = routes.find((candidate) => candidate.key === key);
    if (!route?.selectable) return;
    if (isNativeRoute(route) && route.providerId) await nativeDefault(route.providerId, route.modelId, "");
    else await onSetBackendDefault(null, route.selection);
  };
  const chooseReasoning = async (reasoning: string): Promise<void> => {
    if (effective.source === "global-backend") {
      await onSetBackendDefault(null, { ...effective.selection, reasoningEffort: reasoning || null });
      return;
    }
    if (effective.providerId) await nativeDefault(effective.providerId, effective.modelId, reasoning);
  };
  return (
    <SettingsGroup title="New chats" headingId="new-chats-heading">
      <div className="settings-rows" data-setting-id="new-chat-defaults">
        <SettingSelect
          id="new-chat-model"
          title="Model"
          label="Default model for new chats"
          description={effective.source === "fallback" && storedProvider && fallbackProvider
            ? `${storedProvider.label} is not available, so new chats use ${fallbackProvider.label}.`
            : undefined}
          value={effectiveKey}
          options={modelOptions}
          disabled={disabled}
          onChange={chooseModel}
        />
        <SettingSelect
          id="new-chat-reasoning"
          title="Reasoning"
          label="Default reasoning for new chats"
          value={levels.length > 0 ? effective.reasoning ?? "" : ""}
          options={levels.length > 0 ? reasoningOptions : reasoningOptions.slice(0, 1)}
          disabled={disabled}
          inactive={levels.length === 0}
          onChange={chooseReasoning}
        />
        <SettingSelect
          id="new-chat-work-mode"
          title="Work mode"
          label="Default work mode for new chats"
          value={settings.defaultInteractionMode}
          options={WORK_MODES}
          disabled={disabled}
          onChange={(defaultInteractionMode) => onUpdate({ defaultInteractionMode })}
        />
        <SettingSelect
          id="new-chat-access"
          title="Access"
          label="Default access for new chats"
          value={settings.defaultAccessMode}
          options={ACCESS_MODES}
          disabled={disabled}
          onChange={(defaultAccessMode) => onUpdate({ defaultAccessMode })}
        />
        <SettingSelect
          id="new-chat-location"
          title="Where new chats run"
          value={settings.newThreadMode}
          options={NEW_CHAT_LOCATIONS}
          disabled={disabled}
          onChange={(newThreadMode) => onUpdate({ newThreadMode })}
        />
      </div>
    </SettingsGroup>
  );
}
