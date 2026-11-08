import type { ProviderId, ProviderInfo } from "@shared/contracts";
import type { ProviderAuthMethod } from "@shared/provider";

import { API_KEY_PRESET_FOR_PROVIDER } from "../../utils/backendSettingsModel";
import { providerSetupAction, providerStateLabel } from "../../utils/providerStatus";

export const ADD_PROVIDER_MENU_STEPS = ["Provider", "Identity", "Config"] as const;

export const ADD_PROVIDER_MENU_ORDER = [
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "kimi",
] as const satisfies readonly ProviderId[];

export const ADD_PROVIDER_MENU_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  kimi: "Kimi Code",
  grok: "Grok",
};

export type AddProviderMenuStep = 0 | 1 | 2;
export type AddProviderRoute = "account" | "api-key";

export interface AddProviderMenuItem {
  id: ProviderId;
  label: string;
  stateLabel: string;
  ready: boolean;
}

export interface AddProviderNote {
  text: string;
  more: string | null;
}

export interface AddProviderFact {
  label: string;
  value: string;
}

export interface AddProviderRouteChoice {
  id: AddProviderRoute;
  title: string;
  description: string;
}

export interface AddProviderMethodChoice {
  method: ProviderAuthMethod;
  title: string;
  description: string;
}

export type AddProviderCommand =
  | { type: "cancel" }
  | { type: "back" }
  | { type: "step"; step: AddProviderMenuStep }
  | { type: "connect"; method?: ProviderAuthMethod }
  | { type: "refresh" }
  | { type: "api-key" }
  | { type: "done" };

export interface AddProviderFooterButton {
  command: AddProviderCommand;
  label: string;
  emphasis: "quiet" | "secondary" | "primary";
}

const CODEX_MORE = "Inertia keeps one Codex installation, so signing in again replaces the account Codex already stored. An OpenAI API key is a separate route for API credits. Each chat uses one route.";

const READY_STATE_LABELS: ReadonlySet<string> = new Set(["Connected", "Configured", "Ready"]);

const API_KEY_VENDORS: Readonly<Partial<Record<ProviderId, string>>> = {
  codex: "OpenAI",
  claude: "Anthropic",
  antigravity: "Gemini",
};

const ANTIGRAVITY_POLICY = "Google says wrapping agy in another app isn't supported on consumer plans.";

export function addProviderMenuItems(
  providers: readonly ProviderInfo[],
): readonly AddProviderMenuItem[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return ADD_PROVIDER_MENU_ORDER.map((id) => {
    const provider = byId.get(id);
    const stateLabel = provider ? providerStateLabel(provider) : "Not detected";
    return {
      id,
      label: ADD_PROVIDER_MENU_LABELS[id],
      stateLabel,
      ready: READY_STATE_LABELS.has(stateLabel),
    };
  });
}

export function nextAddProviderMenuIndex(
  current: number,
  key: string,
  count: number,
  columns: number,
): number | null {
  if (count <= 0) return null;
  const width = Math.max(1, Math.floor(columns));
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowRight") return current < 0 ? 0 : Math.min(last, current + 1);
  if (key === "ArrowLeft") return current <= 0 ? 0 : current - 1;
  if (key === "ArrowDown") {
    if (current < 0) return 0;
    const next = current + width;
    return next <= last ? next : current;
  }
  if (key === "ArrowUp") {
    if (current < 0) return 0;
    const next = current - width;
    return next >= 0 ? next : current;
  }
  return null;
}

export function addProviderSupportsApiKey(id: ProviderId): boolean {
  return API_KEY_PRESET_FOR_PROVIDER[id] !== undefined;
}

function providerReady(provider: ProviderInfo | undefined): boolean {
  if (!provider) return false;
  return provider.canRun
    || provider.authState === "authenticated"
    || provider.authState === "configured";
}

export function addProviderNote(
  id: ProviderId,
  provider: ProviderInfo | undefined,
): AddProviderNote {
  if (id === "codex") {
    return providerReady(provider)
      ? {
        text: "Codex is already signed in on this computer. An OpenAI API key is a separate route, not another Codex account.",
        more: CODEX_MORE,
      }
      : {
        text: "Codex signs in with your ChatGPT account. Inertia never sees that password.",
        more: CODEX_MORE,
      };
  }
  if (id === "claude") {
    return {
      text: "Sign in through Claude Code, or add an Anthropic API key to use API credits.",
      more: null,
    };
  }
  if (id === "cursor") {
    return {
      text: "Cursor signs in with its own account. Usage is not reported to Inertia.",
      more: null,
    };
  }
  if (id === "opencode") {
    return {
      text: "OpenCode signs in with opencode auth login and keeps its own keys.",
      more: null,
    };
  }
  if (id === "antigravity") {
    return { text: ANTIGRAVITY_POLICY, more: null };
  }
  if (id === "grok") {
    return provider?.authState === "authenticated" || provider?.authState === "configured"
      ? {
        text: "Grok is already signed in on this computer. Chats use that account.",
        more: null,
      }
      : {
        text: "Grok signs in with grok login. Inertia never sees that password.",
        more: null,
      };
  }
  return {
    text: "Kimi Code signs in with its own account. Usage is not reported to Inertia.",
    more: null,
  };
}

export function addProviderFacts(id: ProviderId): readonly AddProviderFact[] {
  if (id === "codex") {
    return [
      { label: "Sign-in", value: "ChatGPT account, through Codex's own login." },
      { label: "API key", value: "An OpenAI API key, billed to your API credits." },
      { label: "Accounts", value: "One Codex installation. The API key is a separate route." },
    ];
  }
  if (id === "claude") {
    return [
      { label: "Sign-in", value: "Claude account, or Console API billing, through Claude Code." },
      { label: "API key", value: "An Anthropic API key, billed to your API credits." },
      { label: "Usage", value: "Shown when Claude reports a limit." },
    ];
  }
  if (id === "cursor") {
    return [
      { label: "Sign-in", value: "Cursor's own login." },
      { label: "API key", value: "Account only." },
      { label: "Usage", value: "Not reported to Inertia." },
    ];
  }
  if (id === "opencode") {
    return [
      { label: "Sign-in", value: "opencode auth login." },
      { label: "API key", value: "Kept by OpenCode. Add keys in that same login." },
    ];
  }
  if (id === "antigravity") {
    return [
      { label: "Sign-in", value: "Antigravity's own prompt." },
      { label: "API key", value: "Account only." },
      { label: "Policy", value: ANTIGRAVITY_POLICY },
    ];
  }
  if (id === "grok") {
    return [
      { label: "Sign-in", value: "grok login, in Grok's own terminal." },
      { label: "API key", value: "The Grok CLI can use an xAI API key from the environment. Inertia does not store it." },
      { label: "Usage", value: "Not reported to Inertia." },
    ];
  }
  return [
    { label: "Sign-in", value: "Kimi Code's own login." },
    { label: "API key", value: "Add a key on the Kimi Code card. It runs on Claude Code." },
    { label: "Usage", value: "Not reported to Inertia." },
  ];
}

function accountRouteDescription(id: ProviderId): string {
  if (id === "codex") return "Uses the ChatGPT account stored by Codex.";
  if (id === "claude") return "Signs in through Claude Code's own login.";
  if (id === "opencode") return "Runs opencode auth login. OpenCode keeps the keys.";
  if (id === "cursor") return "Uses the account stored by Cursor.";
  if (id === "antigravity") return "Uses the account stored by Antigravity.";
  if (id === "grok") return "Uses the account stored by Grok.";
  return "Uses the account stored by Kimi Code.";
}

function apiKeyRouteDescription(id: ProviderId): string {
  const vendor = API_KEY_VENDORS[id] ?? ADD_PROVIDER_MENU_LABELS[id];
  return `Uses ${/^[AEIOU]/u.test(vendor) ? "an" : "a"} ${vendor} API key, billed to your API credits and kept in the credential vault.`;
}

export function addProviderRoutes(id: ProviderId): readonly AddProviderRouteChoice[] {
  const account: AddProviderRouteChoice = {
    id: "account",
    title: "Account",
    description: accountRouteDescription(id),
  };
  if (!addProviderSupportsApiKey(id)) return [account];
  return [
    account,
    {
      id: "api-key",
      title: "API key",
      description: apiKeyRouteDescription(id),
    },
  ];
}

export function addProviderClaudeMethods(): readonly AddProviderMethodChoice[] {
  return [
    {
      method: "account",
      title: "Claude account",
      description: "Bills your Claude plan.",
    },
    {
      method: "console",
      title: "Console billing",
      description: "Bills your Anthropic Console credits.",
    },
  ];
}

function setupKind(
  provider: ProviderInfo | undefined,
): "connect" | "refresh" | "done" {
  const action = provider ? providerSetupAction(provider) : "refresh";
  if (action === "connect") return "connect";
  if (action === "refresh") return "refresh";
  return "done";
}

function signInLabel(
  id: ProviderId,
  method: ProviderAuthMethod,
  label: string,
): string {
  if (id === "codex") return "Continue with ChatGPT";
  if (id === "claude" && method === "console") return "Sign in for API billing";
  if (id === "claude") return "Sign in through Claude";
  return `Sign in through ${label}`;
}

function quiet(command: AddProviderCommand, label: string): AddProviderFooterButton {
  return { command, label, emphasis: "quiet" };
}

function secondary(command: AddProviderCommand, label: string): AddProviderFooterButton {
  return { command, label, emphasis: "secondary" };
}

function primary(command: AddProviderCommand, label: string): AddProviderFooterButton {
  return { command, label, emphasis: "primary" };
}

export function addProviderFooter(input: {
  step: AddProviderMenuStep;
  providerId: ProviderId;
  provider: ProviderInfo | undefined;
  route: AddProviderRoute;
  claudeMethod: ProviderAuthMethod;
}): readonly AddProviderFooterButton[] {
  const label = ADD_PROVIDER_MENU_LABELS[input.providerId];
  const setup = setupKind(input.provider);
  if (input.step === 0) {
    const buttons = [
      quiet({ type: "cancel" }, "Cancel"),
    ];
    if (input.providerId === "codex") {
      buttons.push(secondary({ type: "step", step: 1 }, "Configure manually"));
      if (setup === "connect") {
        buttons.push(primary({ type: "connect", method: "account" }, "Continue with ChatGPT"));
      } else if (setup === "refresh" && input.provider?.canRun && addProviderSupportsApiKey("codex")) {
        buttons.push(primary({ type: "api-key" }, "Add API key"));
      } else if (setup === "refresh") {
        buttons.push(primary({ type: "refresh" }, "Refresh"));
      } else if (addProviderSupportsApiKey("codex")) {
        buttons.push(primary({ type: "api-key" }, "Add API key"));
      } else {
        buttons.push(primary({ type: "done" }, "Done"));
      }
      return buttons;
    }
    buttons.push(primary({ type: "step", step: 1 }, "Next"));
    return buttons;
  }
  if (input.step === 1) {
    return [
      secondary({ type: "back" }, "Back"),
      primary({ type: "step", step: 2 }, "Next"),
    ];
  }
  const back = secondary({ type: "back" }, "Back");
  if (input.route === "api-key" && addProviderSupportsApiKey(input.providerId)) {
    return [back, primary({ type: "api-key" }, "Add API key")];
  }
  if (setup === "connect") {
    const method = input.providerId === "claude" ? input.claudeMethod : "account";
    return [back, primary({ type: "connect", method }, signInLabel(input.providerId, method, label))];
  }
  if (input.provider?.canRun) return [back, primary({ type: "done" }, "Done")];
  if (setup === "refresh") return [back, primary({ type: "refresh" }, "Refresh")];
  return [back, primary({ type: "done" }, "Done")];
}
