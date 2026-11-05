import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Info } from "lucide-react";
import clsx from "clsx";

import type { AppSettings, ProviderId, ProviderInfo } from "@shared/contracts";
import type { ProviderAuthMethod } from "@shared/provider";
import { focusModalOnAnimationFrame } from "../../utils/modalFocus";
import { providerStateDetail } from "../../utils/providerStatus";
import { DialogShell } from "../DialogShell";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
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

function measuredColumns(value: string): number {
  const count = value.split(" ").filter((part) => part.length > 0 && part !== "none").length;
  return count === 1 ? 1 : 2;
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
  const nameId = useId();
  const nameHintId = useId();
  const [step, setStep] = useState<AddProviderMenuStep>(0);
  const [selectedId, setSelectedId] = useState<ProviderId>("codex");
  const [route, setRoute] = useState<AddProviderRoute>("account");
  const [claudeMethod, setClaudeMethod] = useState<ProviderAuthMethod>("account");
  const [nameOverrides, setNameOverrides] = useState<Partial<Record<ProviderId, string>>>({});
  const [factsOpen, setFactsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [columns, setColumns] = useState(2);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<ProviderId | null>(null);
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
  const binaryValue = selectedId === "codex"
    ? codexBinaryPath || selected?.executable || ""
    : selected?.executable ?? "";

  useLayoutEffect(() => focusModalOnAnimationFrame(() => {
    document.getElementById("add-provider-card-codex")?.focus();
  }), []);

  useLayoutEffect(() => {
    if (step === 1) {
      nameRef.current?.focus();
      return;
    }
    if (step === 2) {
      dialogRef.current?.querySelector<HTMLButtonElement>(".dialog-shell-footer .primary-button")?.focus();
      return;
    }
    document.getElementById(`add-provider-card-${selectedId}`)?.focus();
  }, [step, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  useLayoutEffect(() => {
    const providerId = pendingFocus.current;
    if (!providerId) return;
    pendingFocus.current = null;
    document.getElementById(`add-provider-card-${providerId}`)?.focus();
  }, [selectedId]);

  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const measure = (): void => {
      setColumns(measuredColumns(getComputedStyle(node).gridTemplateColumns));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [step]);

  const chooseProvider = (providerId: ProviderId): void => {
    setSelectedId(providerId);
    setMoreOpen(false);
    if (!addProviderRoutes(providerId).some((choice) => choice.id === route)) setRoute("account");
  };

  const moveSelection = (key: string): void => {
    const current = items.findIndex((item) => item.id === selectedId);
    const next = nextAddProviderMenuIndex(current, key, items.length, columns);
    const item = next === null ? undefined : items[next];
    if (!item || item.id === selectedId) return;
    pendingFocus.current = item.id;
    chooseProvider(item.id);
  };

  const runCommand = (command: AddProviderCommand): void => {
    if (disabled) return;
    if (command.type === "cancel") {
      onClose();
      return;
    }
    if (command.type === "back") {
      setStep((current) => current === 0 ? 0 : (current - 1) as AddProviderMenuStep);
      return;
    }
    if (command.type === "step") {
      setStep(command.step);
      return;
    }
    onSelectProvider(selectedId);
    if (step === 2) onCommitIdentityLabel(selectedId, accountName);
    if (command.type === "connect") onConnectProvider(selectedId, command.method);
    else if (command.type === "refresh") onRefreshProvider(selectedId);
    else if (command.type === "api-key") onAddApiKey(selectedId);
    onClose();
  };

  return (
    <DialogShell
      ref={dialogRef}
      className="add-provider-menu"
      title="Add provider"
      titleId={titleId}
      description="Add an account or configure a provider on this computer."
      descriptionId={descriptionId}
      closeLabel="Close"
      onClose={onClose}
      onDismiss={onClose}
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
                aria-label={`${label}, step ${index + 1}`}
                aria-disabled={disabled || undefined}
                onClick={() => { if (!disabled) setStep(index as AddProviderMenuStep); }}
              >
                <span className="add-provider-step-index" aria-hidden="true">
                  {complete ? <Check size={12} /> : index + 1}
                </span>
                <span className="add-provider-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="add-provider-panel">
        {step === 0 && (
          <>
            <p id={gridLabelId} className="add-provider-grid-label">Provider</p>
            <div
              ref={gridRef}
              className="add-provider-grid"
              role="radiogroup"
              aria-labelledby={gridLabelId}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                moveSelection(event.key);
              }}
            >
              {items.map((item) => {
                const checked = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    id={`add-provider-card-${item.id}`}
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
                    <span className="add-provider-card-copy">
                      <strong>{item.label}</strong>
                      <small>{item.stateLabel}</small>
                    </span>
                    {checked && (
                      <span className="add-provider-card-check" aria-hidden="true">
                        <Check size={14} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="add-provider-note">
              <Info size={16} aria-hidden="true" />
              <div>
                <p>
                  {note.text}
                  {note.more && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="add-provider-more-info"
                        aria-expanded={moreOpen}
                        onClick={() => setMoreOpen((open) => !open)}
                      >
                        {moreOpen ? "Hide info" : "More info"}
                      </button>
                    </>
                  )}
                </p>
                {moreOpen && note.more && <p className="add-provider-note-more">{note.more}</p>}
              </div>
            </div>
            <button
              type="button"
              className="add-provider-show-more"
              aria-expanded={factsOpen}
              onClick={() => setFactsOpen((open) => !open)}
            >
              {factsOpen ? "Show less" : "Show more"}
              {factsOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </button>
            {factsOpen && (
              <dl className="add-provider-facts">
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
          <>
            <p className="add-provider-lead">
              {routes.length > 1
                ? `Name this account, then choose how chats reach ${selectedLabel}.`
                : `Name this account. Chats use the ${selectedLabel} sign-in on this computer.`}
            </p>
            <div className="add-provider-field">
              <label htmlFor={nameId}>Account name</label>
              <input
                ref={nameRef}
                id={nameId}
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
              <small id={nameHintId}>Shown in the provider list. Leave blank to use {selectedLabel}.</small>
            </div>
            {routes.length > 1 && (
              <ChoiceGroup
                label="Route"
                disabled={disabled}
                selected={activeRoute}
                choices={routes.map((choice) => ({
                  id: choice.id,
                  title: choice.title,
                  description: choice.description,
                }))}
                onSelect={(id) => setRoute(id as AddProviderRoute)}
              />
            )}
            {selectedId === "claude" && activeRoute === "account" && (
              <ChoiceGroup
                label="Sign-in"
                disabled={disabled}
                selected={claudeMethod}
                choices={addProviderClaudeMethods().map((choice) => ({
                  id: choice.method,
                  title: choice.title,
                  description: choice.description,
                }))}
                onSelect={(id) => setClaudeMethod(id as ProviderAuthMethod)}
              />
            )}
          </>
        )}

        {step === 2 && (
          <>
            <p className="add-provider-config-copy">
              {selected
                ? providerStateDetail(selected)
                : `${selectedLabel} was not detected on this computer.`}
            </p>
            {activeRoute === "api-key" ? (
              <p className="add-provider-config-copy">
                The next dialog asks for the key name, the key, and which models to offer. Inertia stores the key in your system credential vault.
              </p>
            ) : (
              <p className="add-provider-config-copy">
                {selectedId === "grok"
                  ? primaryCommand?.type === "connect"
                    ? "Continuing runs grok login in Grok's own terminal. The password stays with Grok."
                    : primaryCommand?.type === "done"
                      ? "Grok is ready. New chats use the account stored on this computer."
                      : "Refresh checks whether Grok is installed and signed in."
                  : selectedId === "codex"
                    ? "Continuing opens Codex's own sign-in. The password stays with Codex."
                    : selectedId === "opencode"
                      ? "Continuing runs opencode auth login in a terminal."
                      : `Continuing opens ${selectedLabel}'s own sign-in.`}
              </p>
            )}
            {selectedId === "codex" && activeRoute === "account" && (
              <div className="add-provider-field">
                <span>Executable</span>
                <span className="add-provider-binary">
                  <input
                    className="setting-input"
                    aria-label="Codex executable path"
                    value={binaryValue}
                    placeholder="No working Codex executable detected"
                    readOnly
                    title={binaryValue || undefined}
                  />
                  <span className="add-provider-binary-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      aria-disabled={disabled || undefined}
                      onClick={() => { if (!disabled) onChooseCodexBinary(); }}
                    >
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
          </>
        )}
      </div>
    </DialogShell>
  );
}

function ChoiceGroup({
  label,
  disabled,
  selected,
  choices,
  onSelect,
}: {
  label: string;
  disabled: boolean;
  selected: string;
  choices: readonly { id: string; title: string; description: string }[];
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const labelId = useId();
  return (
    <div className="add-provider-choices">
      <p id={labelId} className="add-provider-choice-label">{label}</p>
      <div
        className="add-provider-choice-list"
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = choices.findIndex((choice) => choice.id === selected);
          const next = nextAddProviderMenuIndex(index, event.key, choices.length, 1);
          const choice = next === null ? undefined : choices[next];
          if (!choice || disabled || choice.id === selected) return;
          onSelect(choice.id);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-choice-id="${choice.id}"]`)?.focus();
        }}
      >
        {choices.map((choice) => {
          const checked = choice.id === selected;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              className={clsx("add-provider-choice", checked && "is-selected")}
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              data-choice-id={choice.id}
              tabIndex={checked ? 0 : -1}
              onClick={() => { if (!disabled) onSelect(choice.id); }}
            >
              <span className="add-provider-choice-copy">
                <strong>{choice.title}</strong>
                <small>{choice.description}</small>
              </span>
              {checked && (
                <span className="add-provider-card-check" aria-hidden="true">
                  <Check size={14} strokeWidth={2.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
