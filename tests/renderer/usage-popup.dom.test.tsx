import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarUsageButton } from "../../src/renderer/src/components/sidebar/SidebarUsageButton";
import { UsageLimitsProvider } from "../../src/renderer/src/components/usage-limits-context";
import { useUsageLimitsContext, type UsagePopupTab } from "../../src/renderer/src/components/usage-limits-state";
import type { UsageOverviewProps } from "../../src/renderer/src/components/usage/UsageOverview";
import {
  DEFAULT_USAGE_POPUP_PREFERENCES,
  readUsagePopupPreferences,
  USAGE_POPUP_PREFERENCES_KEY,
  writeUsagePopupPreferences,
} from "../../src/renderer/src/components/usage/usagePopupPreferences";
import { UsageSurface } from "../../src/renderer/src/components/UsageSurface";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ServerEvent } from "../../src/shared/contracts";
import type { UsageAccount, UsageLimitsSnapshot } from "../../src/shared/provider-usage-limits";
import { usageAccount } from "../helpers/usage-limits";

vi.mock("../../src/renderer/src/components/usage/UsageOverview", () => ({
  UsageOverview: ({ metric, days, hiddenProviderIds, refreshToken, onBusyChange }: UsageOverviewProps) => (
    <section aria-label={metric === "cost" ? "Cost" : "Tokens"} data-days={days} data-hidden={[...hiddenProviderIds].join(",")} data-refresh={refreshToken}>
      <button type="button" onClick={() => onBusyChange?.(true)}>Start loading</button>
      <input aria-label="Model search" />
    </section>
  ),
}));

const claude = usageAccount({ id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "account-b", credits: null, canReset: false });
const hubAccount = usageAccount({ id: "hub:1:second", identityKey: "account-c", sources: ["Home hub"], credits: null, canReset: false });
const hubSource = { id: "1", label: "Home hub", url: "https://hub.example.test", enabled: true, error: null };

function limitsRequest(snapshot: Partial<UsageLimitsSnapshot> = {}) {
  const value: UsageLimitsSnapshot = { accounts: [usageAccount(), claude], sources: [], checkedAt: new Date().toISOString(), ...snapshot };
  return vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => (
    { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.limits", snapshot: value } }
  ));
}

function Openers(): React.JSX.Element {
  const context = useUsageLimitsContext()!;
  const opener = (label: string, tab?: UsagePopupTab) => (
    <button type="button" onClick={(event) => context.open(event.currentTarget, tab)}>{label}</button>
  );
  return <>{opener("Open usage")}{opener("Open cost", "cost")}{opener("Open tokens", "tokens")}{opener("Open limits", "limits")}</>;
}

function renderApp(request = limitsRequest(), children: React.ReactNode = <Openers />) {
  return { request, ...render(<UsageLimitsProvider request={request} status="online">{children}</UsageLimitsProvider>) };
}

async function press(name: string | RegExp): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); await vi.dynamicImportSettled(); });
}

async function openPopup(name = "Open usage"): Promise<HTMLElement> {
  await press(name);
  return screen.findByRole("dialog", { name: "Usage" });
}

const pressedTab = (): string | null => screen.getAllByRole("button", { pressed: true }).find((button) => button.closest(".usage-popup-tabs"))?.textContent ?? null;
const key = async (target: Element, value: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => { fireEvent.keyDown(target, { key: value, ...init }); await vi.dynamicImportSettled(); });
};
const stored = (): unknown => JSON.parse(window.localStorage.getItem(USAGE_POPUP_PREFERENCES_KEY) ?? "null");

beforeEach(() => window.localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe("Usage popup", () => {
  it("opens one modal on Limits the first time, with a breadcrumb, the three tabs, refresh and close", async () => {
    renderApp();
    const dialog = await openPopup();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
    expect(dialog.parentElement).toHaveAttribute("role", "presentation");
    expect(within(dialog).getByRole("heading", { level: 2, name: "Usage" })).toBeVisible();
    const crumbs = within(dialog).getByRole("navigation", { name: "Usage filters" });
    expect(crumbs).toHaveTextContent(/^\/All providers$/u);
    expect(within(within(dialog).getByRole("group", { name: "Usage view" })).getAllByRole("button").map((tab) => tab.textContent)).toEqual(["Cost", "Tokens", "Limits"]);
    expect(within(dialog).getByRole("button", { name: "Cost" })).toHaveAccessibleDescription("C");
    expect(pressedTab()).toBe("Limits");
    expect(await within(dialog).findByRole("region", { name: "Codex limits" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Refresh limits" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close usage" })).toBeVisible();
  });

  it("shows Cost and Tokens with the period crumb and passes the header state to the overview", async () => {
    renderApp();
    const dialog = await openPopup();
    await press("Tokens");
    const tokens = within(dialog).getByRole("region", { name: "Tokens" });
    expect(tokens).toHaveAttribute("data-days", "30");
    expect(tokens).toHaveAttribute("data-refresh", "0");
    expect(within(dialog).queryByRole("region", { name: "Provider limits" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("navigation", { name: "Usage filters" })).toHaveTextContent(/^\/Last 30 days\/All providers$/u);

    fireEvent.click(within(dialog).getByRole("button", { name: "Period: Last 30 days" }));
    const menu = within(dialog).getByRole("menu", { name: "Period" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Last 30 days" })).toHaveFocus();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Last 90 days" }));
    expect(within(dialog).queryByRole("menu")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Period: Last 90 days" })).toHaveFocus();
    expect(within(dialog).getByRole("region", { name: "Tokens" })).toHaveAttribute("data-days", "90");

    await press("Cost");
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-days", "90");
    const refresh = within(dialog).getByRole("button", { name: "Refresh usage" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-refresh", "2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start loading" }));
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toBeDisabled();
    await press("Tokens");
    expect(within(dialog).getByRole("button", { name: "Refresh usage" })).toHaveAttribute("aria-busy", "false");
  });

  it("hides providers from every tab through one checkbox menu and names what is left", async () => {
    renderApp();
    const dialog = await openPopup();
    await within(dialog).findByRole("region", { name: "Claude limits" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Providers: All providers" }));
    const menu = within(dialog).getByRole("menu", { name: "Providers" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((item) => item.textContent)).toEqual([
      "All providers", "Codex", "Claude", "Cursor", "Kimi Code", "OpenCode", "Antigravity", "Grok",
    ]);
    expect(menu.querySelector('[data-provider-id="claude"]')).not.toBeNull();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Claude" }));
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Claude" })).toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "All providers" })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).queryByRole("region", { name: "Claude limits" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Codex limits" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Providers: 6 providers" })).toBeVisible();

    await key(within(menu).getByRole("menuitemcheckbox", { name: "Claude" }), "Escape");
    expect(within(dialog).queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Usage" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Providers: 6 providers" })).toHaveFocus();

    await press("Cost");
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-hidden", "claude");
    fireEvent.click(within(dialog).getByRole("button", { name: "Providers: 6 providers" }));
    fireEvent.click(within(dialog).getByRole("menuitemcheckbox", { name: "All providers" }));
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-hidden", "");
    fireEvent.click(within(dialog).getByRole("menuitemcheckbox", { name: "All providers" }));
    expect(within(dialog).getByRole("button", { name: "Providers: No providers" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("menuitemcheckbox", { name: "Codex" }));
    expect(within(dialog).getByRole("button", { name: "Providers: Codex" })).toBeVisible();
  });

  it("offers the sources crumb on Limits only when a hub exists", async () => {
    const view = renderApp();
    let dialog = await openPopup();
    await within(dialog).findByRole("region", { name: "Codex limits" });
    expect(within(dialog).queryByRole("button", { name: /^Sources:/u })).not.toBeInTheDocument();
    await key(dialog, "Escape");
    view.unmount();

    renderApp(limitsRequest({ accounts: [usageAccount(), hubAccount, claude], sources: [hubSource] }));
    dialog = await openPopup();
    await within(dialog).findByRole("region", { name: "Claude limits" });
    expect(within(dialog).getAllByRole("button", { name: /^Codex account \d: / })).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sources: All sources" }));
    expect(within(dialog).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["All sources", "This computer", "Home hub"]);
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: "Home hub" }));
    expect(within(dialog).getByRole("navigation", { name: "Usage filters" })).toHaveTextContent(/^\/Home hub\/All providers$/u);
    expect(within(dialog).getAllByRole("button", { name: /^Codex account: / })).toHaveLength(1);
    expect(within(dialog).queryByRole("region", { name: "Claude limits" })).not.toBeInTheDocument();
    await press("Tokens");
    expect(within(dialog).queryByRole("button", { name: /^Sources:/u })).not.toBeInTheDocument();
  });

  it("refreshes limits on demand and shows the request as busy", async () => {
    const request = limitsRequest();
    renderApp(request);
    const dialog = await openPopup();
    await within(dialog).findByRole("region", { name: "Codex limits" });
    const refresh = within(dialog).getByRole("button", { name: "Refresh limits" });
    await waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
    let finish!: (event: ServerEvent) => void;
    const answer = await request({ type: "usage.limits.get", payload: { refresh: false, force: false } });
    request.mockClear();
    request.mockImplementation(async (command: CommandWithoutId) => (
      command.type === "usage.limits.get" && command.payload.refresh ? new Promise<ServerEvent>((resolve) => { finish = resolve; }) : answer
    ));
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "true"));
    expect(refresh).toBeDisabled();
    expect(request).toHaveBeenCalledWith({ type: "usage.limits.get", payload: { refresh: true, force: true } });
    expect(within(dialog).getByRole("region", { name: "Codex limits" })).toBeVisible();
    await act(async () => { finish(answer); });
    expect(refresh).toHaveAttribute("aria-busy", "false");
  });
});

describe("Usage popup preferences", () => {
  it("remembers the last tab, period and hidden providers under its own key", async () => {
    const view = renderApp();
    let dialog = await openPopup();
    expect(stored()).toEqual({ tab: "limits", days: 30, hiddenProviders: [] });
    await press("Cost");
    fireEvent.click(within(dialog).getByRole("button", { name: "Period: Last 30 days" }));
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: "Last 7 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Providers: All providers" }));
    fireEvent.click(within(dialog).getByRole("menuitemcheckbox", { name: "Cursor" }));
    expect(stored()).toEqual({ tab: "cost", days: 7, hiddenProviders: ["cursor"] });
    await key(dialog, "Escape");
    view.unmount();

    renderApp();
    dialog = await openPopup();
    expect(pressedTab()).toBe("Cost");
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-days", "7");
    expect(within(dialog).getByRole("region", { name: "Cost" })).toHaveAttribute("data-hidden", "cursor");
    expect(within(dialog).getByRole("button", { name: "Providers: 6 providers" })).toBeVisible();
  });

  it("falls back to Limits and 30 days for missing, damaged or blocked storage", () => {
    expect(readUsagePopupPreferences()).toEqual(DEFAULT_USAGE_POPUP_PREFERENCES);
    window.localStorage.setItem(USAGE_POPUP_PREFERENCES_KEY, "{not json");
    expect(readUsagePopupPreferences()).toEqual(DEFAULT_USAGE_POPUP_PREFERENCES);
    window.localStorage.setItem(USAGE_POPUP_PREFERENCES_KEY, JSON.stringify({ tab: "history", days: 1, hiddenProviders: ["codex", 7, ""] }));
    expect(readUsagePopupPreferences()).toEqual({ tab: "limits", days: 30, hiddenProviders: ["codex"] });
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(readUsagePopupPreferences()).toEqual(DEFAULT_USAGE_POPUP_PREFERENCES);
    expect(() => writeUsagePopupPreferences(DEFAULT_USAGE_POPUP_PREFERENCES)).not.toThrow();
  });
});

describe("Usage popup keyboard", () => {
  it("switches tabs with C, T and L unless a field, a menu or a modifier owns the key", async () => {
    renderApp();
    const dialog = await openPopup();
    await key(dialog, "c");
    expect(pressedTab()).toBe("Cost");
    await key(dialog, "T");
    expect(pressedTab()).toBe("Tokens");
    await key(within(dialog).getByRole("textbox", { name: "Model search" }), "l");
    expect(pressedTab()).toBe("Tokens");
    await key(dialog, "l", { ctrlKey: true });
    await key(dialog, "l", { metaKey: true });
    await key(dialog, "l", { repeat: true });
    expect(pressedTab()).toBe("Tokens");
    fireEvent.click(within(dialog).getByRole("button", { name: "Providers: All providers" }));
    await key(within(dialog).getByRole("menuitemcheckbox", { name: "Codex" }), "l");
    expect(pressedTab()).toBe("Tokens");
    await key(within(dialog).getByRole("menuitemcheckbox", { name: "Codex" }), "Escape");
    await key(document.body, "l");
    expect(pressedTab()).toBe("Limits");
    expect(stored()).toMatchObject({ tab: "limits" });
  });

  it("keeps Tab inside the popup, closes on Escape or the backdrop and returns focus to the opener", async () => {
    renderApp();
    const opener = screen.getByRole("button", { name: "Open tokens" });
    opener.focus();
    let dialog = await openPopup("Open tokens");
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const first = within(dialog).getByRole("button", { name: "Period: Last 30 days" });
    const last = within(dialog).getByRole("textbox", { name: "Model search" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    rects.mockRestore();
    await key(dialog, "Escape");
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    dialog = await openPopup("Open tokens");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    dialog = await openPopup("Open tokens");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close usage" }));
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("Usage popup entry points", () => {
  it("opens on the remembered tab from the sidebar and on the asked tab everywhere else", async () => {
    renderApp(limitsRequest(), <><Openers /><SidebarUsageButton onOpen={() => undefined} /></>);
    const sidebar = screen.getByRole("button", { name: "Usage" });
    expect(sidebar).toHaveAttribute("aria-haspopup", "dialog");
    expect(sidebar).not.toHaveAttribute("aria-current");
    expect(sidebar).toHaveClass("icon-button", "sidebar-destination");
    let dialog = await openPopup("Usage");
    expect(pressedTab()).toBe("Limits");
    await key(dialog, "Escape");
    expect(sidebar).toHaveFocus();

    dialog = await openPopup("Open tokens");
    expect(pressedTab()).toBe("Tokens");
    await key(dialog, "Escape");
    dialog = await openPopup("Usage");
    expect(pressedTab()).toBe("Tokens");
    await key(dialog, "Escape");
    await openPopup("Open cost");
    expect(pressedTab()).toBe("Cost");
    await key(screen.getByRole("dialog", { name: "Usage" }), "Escape");
    await openPopup("Open limits");
    expect(pressedTab()).toBe("Limits");
  });

  it("switches an open popup to the tab another entry point asks for", async () => {
    renderApp();
    await openPopup("Open tokens");
    expect(pressedTab()).toBe("Tokens");
    await press("Open limits");
    expect(screen.getAllByRole("dialog", { name: "Usage" })).toHaveLength(1);
    expect(pressedTab()).toBe("Limits");
    await key(screen.getByRole("dialog", { name: "Usage" }), "Escape");
    expect(screen.getByRole("button", { name: "Open tokens" })).toHaveFocus();
  });

  it("opens All accounts on Limits and Usage history on Tokens from the Usage surface", async () => {
    window.localStorage.setItem(USAGE_POPUP_PREFERENCES_KEY, JSON.stringify({ tab: "cost", days: 30 }));
    renderApp(limitsRequest(), <UsageSurface usage={null} />);
    await openPopup("All accounts");
    expect(pressedTab()).toBe("Limits");
    await key(screen.getByRole("dialog", { name: "Usage" }), "Escape");
    expect(screen.getByRole("button", { name: "All accounts" })).toHaveFocus();
    await openPopup("Usage history");
    expect(pressedTab()).toBe("Tokens");
    await key(screen.getByRole("dialog", { name: "Usage" }), "Escape");
    expect(screen.getByRole("button", { name: "Usage history" })).toHaveFocus();
  });

  it("leaves the Usage surface without popup shortcuts where no popup exists", () => {
    render(<UsageSurface usage={null} />);
    expect(screen.queryByRole("button", { name: "All accounts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Usage history" })).not.toBeInTheDocument();
  });

  it("keeps the popup and its tabs out of the modules the workbench loads at start", async () => {
    const { readSourceText } = await import("../helpers/source-text");
    const loaders = readSourceText("src/renderer/src/components/usageLimitsLoaders.ts");
    const tabs = readSourceText("src/renderer/src/components/usage/usageTabLoaders.ts");
    expect(loaders).toContain('await import("./usage/UsagePopup")');
    expect(tabs).toContain('await import("../UsageLimitsPanel")');
    expect(tabs).toContain('await import("./UsageOverview")');
    for (const file of ["usage-limits-context.tsx", "UsageIndicator.tsx", "UsageSurface.tsx", "sidebar/SidebarUsageButton.tsx", "AppLayout.tsx"]) {
      const source = readSourceText(`src/renderer/src/components/${file}`);
      expect(source, file).not.toMatch(/from "\.{1,2}\/(?:usage\/)?(?:UsagePopup|UsageLimitsPanel|UsageOverview|limitPools|LimitAccountDetails|UsageSources)"/u);
    }
  });
});

describe("Usage accounts seen through several entry points", () => {
  it("never draws the same account twice", async () => {
    const copy: UsageAccount = { ...usageAccount(), id: "hub:1:copy", sources: ["Home hub"] };
    renderApp(limitsRequest({ accounts: [usageAccount(), copy], sources: [hubSource] }));
    const dialog = await openPopup();
    await within(dialog).findByRole("region", { name: "Codex limits" });
    expect(within(dialog).getAllByRole("button", { name: /^Codex account: / })).toHaveLength(1);
  });
});
