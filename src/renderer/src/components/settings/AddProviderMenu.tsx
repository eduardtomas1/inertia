import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, Info } from "lucide-react";
import clsx from "clsx";

import type { AppSettings, ProviderId, ProviderInfo } from "@shared/contracts";
import type { ProviderAuthMethod } from "@shared/provider";
import { focusModalOnAnimationFrame } from "../../utils/modalFocus";
import { providerStateDetail } from "../../utils/providerStatus";
import { DialogShell } from "../DialogShell";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { SettingCopy } from "./SettingsLayout";
import {
  ADD_PROVIDER_MENU_LABELS,
  ADD_PROVIDER_MENU_STEPS,
  addProviderClaudeMethods,
  addProviderFacts,
  addProviderFooter,
  addProviderMenuItems,
  addProviderNote,
  addProviderRoutes,
  nextAddProviderMenuIndex,
  type AddProviderCommand,
  type AddProviderMenuStep,
  type AddProviderRoute,
} from "./addProviderMenuModel";
import "./AddProviderMenu.css";

export interface AddProviderMenuProps {
  providers: readonly ProviderInfo[];
  providerIdentityLabels: AppSettings["providerIdentityLabels"];
  codexBinaryPath: string;
  disabled: boolean;
  onClose: () => void;
  onSelectProvider: (providerId: ProviderId) => void;
  onConnectProvider: (providerId: ProviderId, method?: ProviderAuthMethod) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onCommitIdentityLabel: (providerId: ProviderId, value: string) => void;
  onChooseCodexBinary: () => void;
  onUseAutomaticCodexBinary: () => void;
  onAddApiKey: (providerId: ProviderId) => void;
}

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

function renderedColumns(grid: HTMLElement): number {
  const cards = [...grid.children] as HTMLElement[];
  const top = cards[0]?.offsetTop;
  const columns = cards.filter((card) => card.offsetTop === top).length;
  return columns > 0 && columns < cards.length ? columns : 1;
}

function connectCopy(
  providerId: ProviderId,
  label: string,
  command: AddProviderCommand | undefined,
): string {
  if (command?.type === "done") return `${label} is ready. New chats use the account stored on this computer.`;
  if (command?.type === "refresh") return `Refresh checks whether ${label} is installed and signed in.`;
  if (providerId === "codex") return "Continuing opens Codex's own sign-in. The password stays with Codex.";
  if (providerId === "grok") return "Continuing runs grok login in Grok's own terminal. The password stays with Grok.";
  if (providerId === "opencode") return "Continuing runs opencode auth login in a terminal.";
  return `Continuing opens ${label}'s own sign-in.`;
}

export function AddProviderMenu({
  providers,
  providerIdentityLabels,
  codexBinaryPath,
  disabled,
  onClose,
  onSelectProvider,
  onConnectProvider,
  onRefreshProvider,
  onCommitIdentityLabel,
  onChooseCodexBinary,
  onUseAutomaticCodexBinary,
  onAddApiKey,
}: AddProviderMenuProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const gridLabelId = useId();
  const nameHintId = useId();
  const noteMoreId = useId();
  const factsId = useId();
  const [step, setStep] = useState<AddProviderMenuStep>(0);
  const [selectedId, setSelectedId] = useState<ProviderId>("codex");
  const [route, setRoute] = useState<AddProviderRoute>("account");
  const [claudeMethod, setClaudeMethod] = useState<ProviderAuthMethod>("account");
  const [nameOverrides, setNameOverrides] = useState<Partial<Record<ProviderId, string>>>({});
  const [factsOpen, setFactsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousPanelHeight = useRef<number | null>(null);
  const items = addProviderMenuItems(providers);
  const selected = providers.find((provider) => provider.id === selectedId);
  const selectedLabel = ADD_PROVIDER_MENU_LABELS[selectedId];
  const note = addProviderNote(selectedId, selected);
  const facts = addProviderFacts(selectedId);
  const routes = addProviderRoutes(selectedId);
  const activeRoute = routes.some((choice) => choice.id === route) ? route : "account";
  const accountName = nameOverrides[selectedId] ?? providerIdentityLabels[selectedId] ?? "";
  const footer = addProviderFooter({
    step,
    providerId: selectedId,
    provider: selected,
    route: activeRoute,
    claudeMethod,
  });
  const primaryCommand = footer.find((button) => button.emphasis === "primary")?.command;
  const binaryValue = codexBinaryPath || selected?.executable || "";

  useLayoutEffect(() => focusModalOnAnimationFrame(() => {
    gridRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }), []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const from = previousPanelHeight.current;
    previousPanelHeight.current = null;
    if (panel && from !== null && typeof panel.animate === "function"
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const to = panel.offsetHeight;
      if (Math.abs(to - from) > 1) {
        panel.animate(
          [{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }],
          { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        );
      }
    }
    if (step === 1) nameRef.current?.focus();
    else if (step === 2) dialogRef.current?.querySelector<HTMLElement>(".dialog-shell-footer .primary-button")?.focus();
    else gridRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [step]);

  const goToStep = (next: AddProviderMenuStep): void => {
    if (next === step) return;
    previousPanelHeight.current = panelRef.current?.offsetHeight ?? null;
    setStep(next);
  };

  const chooseProvider = (providerId: ProviderId): void => {
    setSelectedId(providerId);
    setMoreOpen(false);
  };

  const moveSelection = (key: string): void => {
    const grid = gridRef.current;
    if (!grid) return;
    const current = items.findIndex((item) => item.id === selectedId);
    const next = nextAddProviderMenuIndex(current, key, items.length, renderedColumns(grid));
    const item = next === null ? undefined : items[next];
    if (!item || item.id === selectedId) return;
    chooseProvider(item.id);
    grid.querySelector<HTMLElement>(`[data-provider-id="${item.id}"]`)?.focus();
  };

  const runCommand = (command: AddProviderCommand): void => {
    if (disabled) return;
    if (command.type === "cancel") {
      onClose();
      return;
    }
    if (command.type === "back") {
      goToStep(step === 0 ? 0 : (step - 1) as AddProviderMenuStep);
      return;
    }
    if (command.type === "step") {
      goToStep(command.step);
      return;
    }
    onSelectProvider(selectedId);
    const name = nameOverrides[selectedId];
    if (name !== undefined) onCommitIdentityLabel(selectedId, name);
    if (command.type === "connect") onConnectProvider(selectedId, command.method);
    else if (command.type === "refresh") onRefreshProvider(selectedId);
    else if (command.type === "api-key") onAddApiKey(selectedId);
    onClose();
  };

  return (
    <DialogShell
      ref={dialogRef}
      className="add-provider-menu"
      tabIndex={-1}
      title="Add provider"
      titleId={titleId}
      description="Add an account or configure a provider on this computer."
      descriptionId={descriptionId}
      closeLabel="Close"
      onClose={onClose}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      footer={footer.map((button) => (
        <button
          key={button.label}
          type="button"
          className={button.emphasis === "primary"
            ? "primary-button"
            : button.emphasis === "secondary"
              ? "secondary-button"
              : "text-button"}
          aria-disabled={disabled || undefined}
          onClick={() => runCommand(button.command)}
        >
          {button.label === "Continue with ChatGPT" && (
            <ProviderBrandIcon providerId="codex" decorative size={16} />
          )}
          {button.label}
        </button>
      ))}
    >
      <ol className="add-provider-steps" aria-label="Setup progress">
        {ADD_PROVIDER_MENU_STEPS.map((label, index) => {
          const current = index === step;
          const complete = index < step;
          return (
            <li key={label}>
              <button
                type="button"
                className={clsx(
                  "add-provider-step",
                  current && "is-current",
                  complete && "is-complete",
                )}
                aria-current={current ? "step" : undefined}
                aria-label={`${label}, step ${index + 1}${complete && index === 0 ? `, ${selectedLabel}` : ""}`}
                aria-disabled={disabled || undefined}
                onClick={() => { if (!disabled) goToStep(index as AddProviderMenuStep); }}
              >
                <span className="add-provider-step-index" aria-hidden="true">
                  {complete ? <Check size={12} strokeWidth={2.75} /> : index + 1}
                </span>
                <span className="add-provider-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div ref={panelRef} className="add-provider-panel" data-step={step}>
        {step === 0 && (
          <>
            <p id={gridLabelId} className="add-provider-label">Provider</p>
            <div
              ref={gridRef}
              className="add-provider-grid"
              role="radiogroup"
              aria-labelledby={gridLabelId}
              onKeyDown={(event) => {
                if (!NAVIGATION_KEYS.has(event.key)) return;
                event.preventDefault();
                moveSelection(event.key);
              }}
            >
              {items.map((item) => {
                const checked = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    className={clsx("add-provider-card", checked && "is-selected")}
                    aria-checked={checked}
                    aria-label={`${item.label}, ${item.stateLabel}`}
                    tabIndex={checked ? 0 : -1}
                    data-provider-id={item.id}
                    onClick={() => chooseProvider(item.id)}
                  >
                    <ProviderBrandIcon providerId={item.id} decorative size={16} />
                    <span className="add-provider-card-name">{item.label}</span>
                    {!item.ready && (
                      <span className="add-provider-card-state" aria-hidden="true">{item.stateLabel}</span>
                    )}
                    <span className="add-provider-card-check" aria-hidden="true">
                      <Check size={12} strokeWidth={2.75} />
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="add-provider-note">
              <Info size={15} aria-hidden="true" />
              <p>
                {note.text}
                {note.more && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="add-provider-inline-link"
                      aria-expanded={moreOpen}
                      aria-controls={noteMoreId}
                      onClick={() => setMoreOpen((open) => !open)}
                    >
                      {moreOpen ? "Less info" : "More info"}
                    </button>
                  </>
                )}
                {moreOpen && note.more && (
                  <span id={noteMoreId} className="add-provider-note-more">{note.more}</span>
                )}
              </p>
            </div>
            <button
              type="button"
              className={clsx("add-provider-show-more", factsOpen && "is-open")}
              aria-expanded={factsOpen}
              aria-controls={factsId}
              onClick={() => setFactsOpen((open) => !open)}
            >
              {factsOpen ? "Show less" : "Show more"}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {factsOpen && (
              <dl id={factsId} className="add-provider-facts">
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}

        {step === 1 && (
          <div className="add-provider-rows">
            <div className="setting-row setting-text-field" data-setting-id="add-provider-name">
              <SettingCopy
                title={<label htmlFor={`${titleId}-name`}>Account name</label>}
                description={<span id={nameHintId}>Shown in the provider list. Leave blank to use {selectedLabel}.</span>}
              />
              <span className="setting-field-control">
                <input
                  ref={nameRef}
                  id={`${titleId}-name`}
                  className="setting-input"
                  aria-describedby={nameHintId}
                  value={accountName}
                  maxLength={48}
                  placeholder={`${selectedLabel} account`}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setNameOverrides((current) => ({ ...current, [selectedId]: value }));
                  }}
                />
              </span>
            </div>
            <div className="setting-row" data-setting-id="add-provider-identity">
              <SettingCopy
                title="Provider"
                description={selected ? providerStateDetail(selected) : `${selectedLabel} was not detected on this computer.`}
              />
              <span className="add-provider-identity-chip">
                <ProviderBrandIcon providerId={selectedId} decorative size={14} />
                {accountName.trim() || selectedLabel}
              </span>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="add-provider-rows">
            {routes.length > 1 && (
              <div className="setting-row" data-setting-id="add-provider-route">
                <SettingCopy
                  title="Connect with"
                  description={routes.find((choice) => choice.id === activeRoute)?.description}
                />
                <Segmented
                  label="Connect with"
                  disabled={disabled}
                  selected={activeRoute}
                  choices={routes.map((choice) => ({ id: choice.id, title: choice.title }))}
                  onSelect={(id) => setRoute(id as AddProviderRoute)}
                />
              </div>
            )}
            {selectedId === "claude" && activeRoute === "account" && (
              <div className="setting-row" data-setting-id="add-provider-claude-method">
                <SettingCopy
                  title="Billing"
                  description={addProviderClaudeMethods().find((choice) => choice.method === claudeMethod)?.description}
                />
                <Segmented
                  label="Billing"
                  disabled={disabled}
                  selected={claudeMethod}
                  choices={addProviderClaudeMethods().map((choice) => ({ id: choice.method, title: choice.title }))}
                  onSelect={(id) => setClaudeMethod(id as ProviderAuthMethod)}
                />
              </div>
            )}
            {selectedId === "codex" && activeRoute === "account" && (
              <div className="setting-row provider-settings-binary" data-setting-id="add-provider-binary">
                <SettingCopy title="Executable" description="Inertia finds Codex automatically unless you choose one." />
                <span className="provider-settings-binary-control">
                  <input
                    className="setting-input"
                    aria-label="Codex executable path"
                    value={binaryValue}
                    placeholder="No working Codex executable detected"
                    readOnly
                    title={binaryValue || undefined}
                  />
                  <span className="provider-settings-binary-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      aria-disabled={disabled || undefined}
                      onClick={() => { if (!disabled) onChooseCodexBinary(); }}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      Browse
                    </button>
                    {codexBinaryPath && (
                      <button
                        type="button"
                        className="secondary-button"
                        aria-disabled={disabled || undefined}
                        onClick={() => { if (!disabled) onUseAutomaticCodexBinary(); }}
                      >
                        Use automatic
                      </button>
                    )}
                  </span>
                </span>
              </div>
            )}
            <p className="add-provider-hint">
              {activeRoute === "api-key"
                ? "The next dialog asks for the key name, the key, and which models to offer. Inertia keeps the key in your system credential vault."
                : connectCopy(selectedId, selectedLabel, primaryCommand)}
            </p>
          </div>
        )}
      </div>
    </DialogShell>
  );
}

function Segmented({
  label,
  disabled,
  selected,
  choices,
  onSelect,
}: {
  label: string;
  disabled: boolean;
  selected: string;
  choices: readonly { id: string; title: string }[];
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div
      className="add-provider-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (!NAVIGATION_KEYS.has(event.key)) return;
        event.preventDefault();
        const index = choices.findIndex((choice) => choice.id === selected);
        const next = nextAddProviderMenuIndex(index, event.key, choices.length, 1);
        const choice = next === null ? undefined : choices[next];
        if (!choice || disabled || choice.id === selected) return;
        onSelect(choice.id);
        event.currentTarget.querySelector<HTMLElement>(`[data-choice-id="${choice.id}"]`)?.focus();
      }}
    >
      {choices.map((choice) => {
        const checked = choice.id === selected;
        return (
          <button
            key={choice.id}
            type="button"
            role="radio"
            className={clsx(checked && "is-active")}
            aria-checked={checked}
            aria-disabled={disabled || undefined}
            data-choice-id={choice.id}
            tabIndex={checked ? 0 : -1}
            onClick={() => { if (!disabled) onSelect(choice.id); }}
          >
            {choice.title}
          </button>
        );
      })}
    </div>
  );
}
