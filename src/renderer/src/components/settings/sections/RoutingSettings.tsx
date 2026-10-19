import { useEffect, useId, useRef, useState } from "react";

import type { AppSettings, AppSettingsUpdate, ModelBackendProfileView, ProviderInfo } from "@shared/contracts";
import {
  ROUTING_PICKER_DESCRIPTIONS,
  ROUTING_CONFIDENCE_CONTROL_MAX,
  ROUTING_CONFIDENCE_CONTROL_MIN,
  ROUTING_PICKERS,
  ROUTING_QUOTA_RESERVE_MAX,
  ROUTING_QUOTA_RESERVE_MIN,
  ROUTING_TIER_LABELS,
  ROUTING_TIERS,
  type RoutingSettingsUpdate,
  type RoutingStickiness,
  type RoutingTier,
} from "@shared/routing/routing-policy";
import { RoutingTierPresets } from "../../routing/RoutingTierPresets";
import { SettingRadioGroup, SettingSelect, SettingSwitch } from "../SettingControls";
import { SettingRow, SettingsGroup } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";

type Update = (settings: AppSettingsUpdate) => Promise<void>;

const PICKER_OPTIONS = ROUTING_PICKERS.map((value) => ({ value, label: value === "rules" ? "Rules (built in)" : value }));
const TIER_OPTIONS = ROUTING_TIERS.map((value) => ({ value, label: ROUTING_TIER_LABELS[value] }));
const STICKINESS_OPTIONS: Array<{ value: RoutingStickiness; label: string }> = [
  { value: "sticky", label: "Stay on provider" },
  { value: "rebalance", label: "Rebalance" },
];

/** Clamps a slider value into the control's documented range and step. */
export function clampRoutingControl(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const stepped = Math.round((Math.min(max, Math.max(min, value)) - min) / step) * step + min;
  return Math.round(Math.min(max, Math.max(min, stepped)) * 100) / 100;
}

function RoutingRange({
  id,
  title,
  description,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onCommit,
}: {
  id: string;
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  disabled: boolean;
  onCommit: (value: number) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const commit = useRef<(next: number) => void>(() => undefined);
  // The native change listener reads the latest props through this ref; it is
  // refreshed after each render, never during one.
  useEffect(() => {
    commit.current = (raw) => {
      const next = clampRoutingControl(raw, min, max, step);
      setDraft(null);
      if (next === (pending ?? value)) return;
      setPending(next);
      void action.run(() => onCommit(next)).then((saved) => {
        if (!saved) setPending((current) => (current === next ? null : current));
      });
    };
  });
  useEffect(() => {
    if (pending !== null && pending === value) setPending(null);
  }, [pending, value]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onChange = (): void => commit.current(Number(element.value));
    element.addEventListener("change", onChange);
    return () => element.removeEventListener("change", onChange);
  }, []);
  const shown = clampRoutingControl(draft ?? pending ?? value, min, max, step);
  return (
    <SettingRow id={id} title={title} description={description} notice={action.notice}>
      <span className="setting-range">
        <input
          ref={input}
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={shown}
          aria-label={title}
          aria-valuetext={format(shown)}
          disabled={disabled}
          onChange={(event) => {
            if (event.nativeEvent.type !== "change") setDraft(Number(event.currentTarget.value));
          }}
        />
        <output htmlFor={inputId}>{format(shown)}</output>
      </span>
    </SettingRow>
  );
}

export function RoutingSettings({
  settings,
  disabled,
  providers,
  backendProfiles,
  onUpdate,
}: {
  settings: AppSettings;
  disabled: boolean;
  providers: ProviderInfo[];
  backendProfiles: ModelBackendProfileView[];
  onUpdate: Update;
}): React.JSX.Element {
  const routing = settings.routing;
  const update = (next: RoutingSettingsUpdate): Promise<void> => onUpdate({ routing: next });
  return (
    <>
      <SettingsGroup
        title="Auto routing"
        headingId="routing-heading"
        description="Pick Auto in a chat's model chooser and Inertia chooses a model for each new message. Picking a model yourself turns Auto off for that chat."
      >
        <div className="settings-rows">
          <SettingSwitch
            id="routing-enabled"
            title="Enable Auto routing"
            description="Off by default. When off, Auto is hidden and every chat keeps the model you chose."
            checked={routing.enabled}
            disabled={disabled}
            onChange={(enabled) => update({ enabled })}
          />
          <SettingSwitch
            id="routing-new-chats"
            title="Use Auto for new chats"
            checked={routing.autoForNewChats}
            disabled={disabled}
            inactive={!routing.enabled}
            onChange={(autoForNewChats) => update({ autoForNewChats })}
          />
          <SettingSelect
            id="routing-picker"
            title="Picker"
            description={ROUTING_PICKER_DESCRIPTIONS[routing.picker]}
            value={routing.picker}
            options={PICKER_OPTIONS}
            disabled={disabled}
            onChange={(picker) => update({ picker })}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Decisions" headingId="routing-decisions-heading">
        <div className="settings-rows">
          <RoutingRange
            id="routing-confidence"
            title="Confidence threshold"
            description="Below this, Auto uses the fallback tier instead of the picker's tier."
            value={routing.confidenceThreshold}
            min={ROUTING_CONFIDENCE_CONTROL_MIN}
            max={ROUTING_CONFIDENCE_CONTROL_MAX}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            disabled={disabled}
            onCommit={(confidenceThreshold) => update({ confidenceThreshold })}
          />
          <SettingSelect<RoutingTier>
            id="routing-fallback-tier"
            title="Fallback tier"
            value={routing.fallbackTier}
            options={TIER_OPTIONS}
            disabled={disabled}
            onChange={(fallbackTier) => update({ fallbackTier })}
          />
          <SettingRadioGroup<RoutingStickiness>
            id="routing-stickiness"
            title="Provider switching"
            description="Staying on the chat's provider keeps its session; Auto still adjusts the model and reasoning."
            value={routing.stickiness}
            options={STICKINESS_OPTIONS}
            disabled={disabled}
            onChange={(stickiness) => update({ stickiness })}
          />
          <RoutingRange
            id="routing-quota-reserve"
            title="Quota reserve"
            description="Skip an account whose remaining usage is below this share."
            value={routing.quotaReservePercent}
            min={ROUTING_QUOTA_RESERVE_MIN}
            max={ROUTING_QUOTA_RESERVE_MAX}
            step={5}
            format={(value) => `${value}%`}
            disabled={disabled}
            onCommit={(quotaReservePercent) => update({ quotaReservePercent })}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup
        title="Tier presets"
        headingId="routing-presets-heading"
        description="Each tier lists the models Auto may use, in order. A tier you have not customised follows your signed-in providers."
      >
        <RoutingTierPresets
          routing={routing}
          defaultProvider={settings.defaultProvider}
          providers={providers}
          backendProfiles={backendProfiles}
          disabled={disabled}
          onUpdate={update}
        />
      </SettingsGroup>
    </>
  );
}
