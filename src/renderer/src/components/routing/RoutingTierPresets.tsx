import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Gauge, Trash2 } from "lucide-react";

import type { ModelBackendProfileView, ProviderId, ProviderInfo } from "@shared/contracts";
import {
  effectiveRoutingPresets,
  routingCatalogFromProviders,
  type RoutingCatalogEntry,
} from "@shared/routing/routing-catalog";
import {
  MAX_ROUTING_PRESETS_PER_TIER,
  ROUTING_TIER_LABELS,
  ROUTING_TIERS,
  ROUTING_WEIGHT_LABELS,
  ROUTING_WEIGHTS,
  type RoutingPreset,
  type RoutingSettings,
  type RoutingSettingsUpdate,
  type RoutingTier,
  type RoutingWeight,
} from "@shared/routing/routing-policy";
import { SettingNoteStatus } from "../settings/SettingsLayout";
import { useSettingAction } from "../settings/useSettingAction";
import { IconButton } from "../ui";
import "./routing.css";

const TIER_HINTS: Readonly<Record<RoutingTier, string>> = {
  light: "Questions and small edits",
  standard: "Everyday feature work",
  heavy: "Debugging, reviews and plans",
  max: "The hardest problems",
};

export interface RoutingPresetOption {
  key: string;
  label: string;
  preset: Omit<RoutingPreset, "weight">;
}

function presetKey(preset: Omit<RoutingPreset, "weight">): string {
  return JSON.stringify([preset.providerId, preset.backendProfileId, preset.modelId, preset.reasoningEffort, preset.fastMode]);
}

/** Every catalog model × reasoning level the user can add to a tier. */
export function routingPresetOptions(catalog: readonly RoutingCatalogEntry[]): RoutingPresetOption[] {
  return catalog.flatMap((entry) => entry.models.flatMap((model) => {
    const efforts: Array<string | null> = model.reasoningOptions.length > 0 ? [...model.reasoningOptions] : [null];
    return efforts.map((reasoningEffort) => {
      const preset = {
        providerId: entry.providerId,
        backendProfileId: entry.backendProfileId,
        modelId: model.id,
        reasoningEffort,
        fastMode: false,
      };
      return {
        key: presetKey(preset),
        label: `${entry.label} · ${model.label}${reasoningEffort ? ` · ${reasoningEffort}` : ""}`,
        preset,
      };
    });
  }));
}

export function routingPresetLabel(preset: RoutingPreset, catalog: readonly RoutingCatalogEntry[]): string {
  const entry = catalog.find(({ providerId, backendProfileId }) =>
    providerId === preset.providerId && backendProfileId === preset.backendProfileId);
  const model = entry?.models.find(({ id }) => id === preset.modelId);
  return [
    entry?.label ?? preset.providerId,
    model?.label ?? preset.modelId,
    preset.reasoningEffort,
    preset.fastMode ? "Fast" : null,
  ].filter(Boolean).join(" · ");
}

function rowKeys(presets: readonly RoutingPreset[]): string[] {
  const seen = new Map<string, number>();
  return presets.map((preset) => {
    const key = presetKey(preset);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return `${key}#${count}`;
  });
}

function TierEditor({
  tier,
  custom,
  presets,
  catalog,
  options,
  fastModels,
  disabled,
  onSave,
}: {
  tier: RoutingTier;
  custom: boolean;
  presets: readonly RoutingPreset[];
  catalog: readonly RoutingCatalogEntry[];
  options: readonly RoutingPresetOption[];
  fastModels: ReadonlySet<string>;
  disabled: boolean;
  onSave: (presets: RoutingPreset[] | null) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const [choice, setChoice] = useState("");
  const [draft, setDraft] = useState<RoutingPreset[] | null | undefined>(undefined);
  const container = useRef<HTMLElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const authoritative = custom ? presets : null;
  useEffect(() => {
    if (draft !== undefined && JSON.stringify(draft) === JSON.stringify(authoritative)) setDraft(undefined);
  }, [authoritative, draft]);
  useEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    container.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  const shownCustom = draft === undefined ? custom : draft !== null;
  const shown = draft === undefined ? presets : draft ?? presets;
  const keys = rowKeys(shown);
  const save = (next: RoutingPreset[] | null, focus?: string): void => {
    setDraft(next);
    if (focus) pendingFocus.current = focus;
    void action.run(() => onSave(next)).then((saved) => {
      if (!saved) setDraft(undefined);
    });
  };
  const list = shownCustom ? [...shown] : [];
  const label = ROUTING_TIER_LABELS[tier];
  const atLimit = list.length >= MAX_ROUTING_PRESETS_PER_TIER;
  const add = (): void => {
    const option = options.find(({ key }) => key === choice);
    if (!option || atLimit) return;
    save([...(shownCustom ? list : shown), { ...option.preset, weight: "normal" }]);
  };
  return (
    <section ref={container} className="routing-tier" aria-labelledby={`routing-tier-${tier}`} data-routing-tier={tier}>
      <div className="routing-tier-heading">
        <h4 id={`routing-tier-${tier}`}>{label} <small>{TIER_HINTS[tier]}</small></h4>
        <small>{shownCustom ? "Custom" : "Defaults"}</small>
      </div>
      {shown.length === 0 && (
        <p className="routing-tier-empty">
          {shownCustom ? "No presets. Auto falls back to a nearby tier." : "No signed-in provider advertises models yet."}
        </p>
      )}
      {shown.length > 0 && (
        <ol className="routing-preset-list" aria-label={`${label} presets`}>
          {shown.map((preset, index) => {
            const name = routingPresetLabel(preset, catalog);
            return (
              <li key={keys[index]} className="routing-preset">
                <span className="routing-preset-label" title={name}>
                  {name}
                  {!shownCustom && <small>{ROUTING_WEIGHT_LABELS[preset.weight]}</small>}
                </span>
                {shownCustom ? (
                  <>
                    <select
                      className="setting-select"
                      aria-label={`Weight for ${name}`}
                      value={preset.weight}
                      disabled={disabled}
                      onChange={(event) => save(list.map((entry, position) => position === index
                        ? { ...entry, weight: event.currentTarget.value as RoutingWeight }
                        : entry))}
                    >
                      {ROUTING_WEIGHTS.map((weight) => (
                        <option key={weight} value={weight}>{ROUTING_WEIGHT_LABELS[weight]}</option>
                      ))}
                    </select>
                    <span className="routing-preset-actions">
                      {fastModels.has(`${preset.backendProfileId}\0${preset.modelId}`) && (
                        <IconButton
                          label={preset.fastMode ? `Use Standard speed for ${name}` : `Use Fast mode for ${name}`}
                          aria-pressed={preset.fastMode}
                          disabled={disabled}
                          onClick={() => save(list.map((entry, position) => position === index
                            ? { ...entry, fastMode: !entry.fastMode }
                            : entry))}
                        >
                          <Gauge size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        label={`Move ${name} up`}
                        disabled={disabled || index === 0}
                        data-routing-action={`up-${index}`}
                        onClick={() => {
                          const next = [...list];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          save(next, `[data-routing-action="${index - 1 === 0 ? "down" : "up"}-${index - 1}"]`);
                        }}
                      >
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        label={`Move ${name} down`}
                        disabled={disabled || index === list.length - 1}
                        data-routing-action={`down-${index}`}
                        onClick={() => {
                          const next = [...list];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          save(next, `[data-routing-action="${index + 1 === list.length - 1 ? "up" : "down"}-${index + 1}"]`);
                        }}
                      >
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton
                        label={`Remove ${name}`}
                        disabled={disabled}
                        data-routing-action={`remove-${index}`}
                        onClick={() => save(
                          list.filter((_, position) => position !== index),
                          list.length > 1
                            ? `[data-routing-action="remove-${Math.min(index, list.length - 2)}"]`
                            : `select[data-routing-add]`,
                        )}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </span>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <div className="routing-tier-actions">
        <select
          className="setting-select"
          aria-label={`Model to add to ${label}`}
          data-routing-add=""
          value={choice}
          disabled={disabled || options.length === 0}
          onChange={(event) => setChoice(event.currentTarget.value)}
        >
          <option value="">Choose a model…</option>
          {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
        <button type="button" className="secondary-button" disabled={disabled || !choice || atLimit} onClick={add}>
          Add to {label}
        </button>
        {shownCustom ? (
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => save(null, `select[data-routing-add]`)}>
            Reset {label} to defaults
          </button>
        ) : shown.length > 0 && (
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => save([...shown], `select[data-routing-add]`)}>
            Customize {label}
          </button>
        )}
        {atLimit && <small className="routing-tier-empty" role="status">A tier holds at most {MAX_ROUTING_PRESETS_PER_TIER} presets.</small>}
        <SettingNoteStatus notice={action.notice} />
      </div>
    </section>
  );
}

export function RoutingTierPresets({
  routing,
  defaultProvider,
  providers,
  backendProfiles,
  disabled,
  onUpdate,
}: {
  routing: Pick<RoutingSettings, "tiers">;
  defaultProvider: ProviderId;
  providers: readonly ProviderInfo[];
  backendProfiles: readonly ModelBackendProfileView[];
  disabled: boolean;
  onUpdate: (update: RoutingSettingsUpdate) => Promise<void>;
}): React.JSX.Element {
  const catalog = useMemo(() => routingCatalogFromProviders(providers, backendProfiles), [backendProfiles, providers]);
  const effective = useMemo(
    () => effectiveRoutingPresets(routing, catalog, defaultProvider),
    [catalog, defaultProvider, routing],
  );
  const options = useMemo(() => routingPresetOptions(catalog), [catalog]);
  const fastModels = useMemo(() => new Set(catalog.flatMap((entry) =>
    entry.models.filter(({ fastMode }) => fastMode).map(({ id }) => `${entry.backendProfileId}\0${id}`))), [catalog]);
  return (
    <div className="routing-tier-presets" data-setting-id="routing-tier-presets" role="group" aria-label="Tier presets">
      {ROUTING_TIERS.map((tier) => (
        <TierEditor
          key={tier}
          tier={tier}
          custom={routing.tiers[tier].presets !== null}
          presets={effective[tier]}
          catalog={catalog}
          options={options}
          fastModels={fastModels}
          disabled={disabled}
          onSave={(presets) => onUpdate({ tiers: { [tier]: { presets } } })}
        />
      ))}
    </div>
  );
}
