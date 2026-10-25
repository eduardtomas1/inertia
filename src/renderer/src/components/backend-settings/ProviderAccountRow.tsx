import { useCallback, useId, useRef } from "react";
import { ChevronDown, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import clsx from "clsx";

import type { ProviderId, ProviderInfo } from "@shared/contracts";
import type { ProviderAuthMethod } from "@shared/provider";
import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import {
  providerAccountState,
  type BackendStateLabel,
} from "../../utils/backendSettingsModel";
import { providerSetupAction } from "../../utils/providerStatus";
import { FocusFirstMenuItem } from "../workspace-header/FocusFirstMenuItem";
import { useFocusOutDismiss } from "../workspace-header/useFocusOutDismiss";
import { ProviderActionIcon } from "../ProviderStatus";
import { LoadingMark } from "../ui";

export function BackendStateBadge({
  state,
  id,
}: {
  state: BackendStateLabel;
  id?: string;
}): React.JSX.Element {
  const Icon = state.tone === "ready"
    ? CircleCheck
    : state.tone === "checking"
      ? LoadingMark
      : state.tone === "idle"
        ? CircleDot
        : CircleAlert;
  return (
    <span id={id} className={clsx("backend-profile-state", `is-${state.tone}`)}>
      <Icon size={14} aria-hidden="true" />
      <span>{state.label}</span>
    </span>
  );
}

const CLAUDE_SIGN_IN_METHODS: readonly {
  method: ProviderAuthMethod;
  title: string;
  description: string;
}[] = [
  {
    method: "account",
    title: "Sign in through Claude Code",
    description: "Uses your Claude account, through Claude Code's own login.",
  },
  {
    method: "console",
    title: "Sign in for API billing through Claude Code",
    description: "Uses your Anthropic Console credits.",
  },
];

function ClaudeConnectMenu({
  label,
  providerName,
  disabled,
  onConnect,
}: {
  label: string;
  providerName: string;
  disabled: boolean;
  onConnect: (method: ProviderAuthMethod) => void;
}): React.JSX.Element {
  const menuId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"sign-in">();
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(anchorRef, menu === "sign-in", dismissOnFocusOut);
  const open = menu === "sign-in";
  return (
    <span ref={anchorRef} className="backend-account-menu-anchor">
      <button
        ref={(node) => setMenuTrigger("sign-in", node)}
        type="button"
        className="secondary-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) toggleMenu("sign-in"); }}
      >
        <ProviderActionIcon action="connect" />
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={(node) => setMenuPopover("sign-in", node)}
          id={menuId}
          className="header-popover backend-account-menu"
          role="menu"
          aria-label={`${providerName} sign-in`}
          onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]')}
        >
          {CLAUDE_SIGN_IN_METHODS.map((item) => (
            <button
              key={item.method}
              type="button"
              role="menuitem"
              className="backend-account-menu-item"
              onClick={() => {
                dismissMenu("selection");
                onConnect(item.method);
              }}
            >
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </button>
          ))}
          <FocusFirstMenuItem menuId={menuId} />
        </div>
      )}
    </span>
  );
}

export function ProviderAccountRow({
  providerId,
  providerName,
  provider,
  identityLabel,
  disabled,
  onConnect,
  onRefresh,
}: {
  providerId: ProviderId;
  providerName: string;
  provider: ProviderInfo | undefined;
  identityLabel: string | undefined;
  disabled: boolean;
  onConnect: (providerId: ProviderId, method?: ProviderAuthMethod) => void;
  onRefresh: (providerId: ProviderId) => void;
}): React.JSX.Element {
  const stateId = useId();
  const state = providerAccountState(provider, identityLabel);
  const action = provider ? providerSetupAction(provider) : "refresh";
  const claudeMenu = providerId === "claude" && action === "connect";
  const claudeBilling = providerId === "claude"
    && provider?.installState === "installed"
    && provider.canRun
    && (provider.authState === "authenticated" || provider.authState === "configured");
  return (
    <div className="backend-account-row">
      <span className="backend-account-copy">
        <strong>Account</strong>
        <BackendStateBadge state={state} id={stateId} />
      </span>
      {claudeMenu ? (
        <ClaudeConnectMenu
          label={`Sign in through ${providerName}`}
          providerName={providerName}
          disabled={disabled}
          onConnect={(method) => onConnect(providerId, method)}
        />
      ) : action && (
        <span className="backend-account-actions">
          {claudeBilling && (
            <button
              type="button"
              className="secondary-button"
              aria-label="Sign in for API billing through Claude Code"
              aria-disabled={disabled || undefined}
              onClick={() => { if (!disabled) onConnect(providerId, "console"); }}
            >
              <ProviderActionIcon action="connect" />
              Sign in for API billing through Claude Code
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            aria-label={action === "connect" ? `Sign in through ${providerName}` : `Refresh ${providerName}`}
            aria-describedby={stateId}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (disabled) return;
              if (action === "connect") onConnect(providerId);
              else onRefresh(providerId);
            }}
          >
            <ProviderActionIcon action={action} />
            {action === "connect" ? `Sign in through ${providerName}` : "Refresh"}
          </button>
        </span>
      )}
    </div>
  );
}
