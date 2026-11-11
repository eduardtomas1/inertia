import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  UsageOverview,
  type UsageOverviewProps,
} from "../../src/renderer/src/components/usage/UsageOverview";
import type { ServerEvent, UsageDashboard } from "../../src/shared/contracts";
import { readSourceText } from "../helpers/source-text";
import { declarationsFor, parseCssRules } from "./css-rules";
import {
  cost,
  dashboardResult,
  emptyDashboard,
  metric,
  unpricedDashboard,
  usageDashboard,
  zero,
} from "./usage-overview-fixture";

type Request = UsageOverviewProps["request"];

const NO_HIDDEN_PROVIDERS: ReadonlySet<string> = new Set();

function requestFor(build: (days: 7 | 30 | 90) => UsageDashboard = usageDashboard) {
  return vi.fn<Request>(async (command) => {
    if (command.type !== "usage.dashboard.get") throw new Error("Unexpected command");
    return dashboardResult(build(command.payload.days));
  });
}

function deferredRequests() {
  const pending: {
    days: number;
    resolve(event: ServerEvent): void;
    reject(error: Error): void;
  }[] = [];
  const request = vi.fn<Request>((command) => new Promise<ServerEvent>((resolve, reject) => {
    if (command.type !== "usage.dashboard.get") throw new Error("Unexpected command");
    pending.push({ days: command.payload.days, resolve, reject });
  }));
  return { pending, request };
}

function overview(overrides: Partial<UsageOverviewProps> = {}): React.JSX.Element {
  return (
    <UsageOverview
      metric="cost"
      days={30}
      hiddenProviderIds={NO_HIDDEN_PROVIDERS}
      refreshToken={0}
      status="online"
      request={requestFor()}
      {...overrides}
    />
  );
}

function headline(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".usage-overview-headline > strong");
  expect(element).not.toBeNull();
  return element!;
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".usage-overview")!;
}

function withTotalCost(days: 7 | 30 | 90, value: number): UsageDashboard {
  const dashboard = usageDashboard(days);
  dashboard.totals.cost = cost(value, 6, 6);
  return dashboard;
}

describe("UsageOverview", () => {
  it("renders the Cost tab as an API estimate with providers, chart, totals, types and models", async () => {
    const view = render(overview());

    expect(await screen.findByRole("heading", { name: "Daily cost" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Cost" })).toHaveAttribute("data-metric", "cost");
    expect(headline(view.container)).toHaveTextContent(/^\$13\.75$/u);
    const subline = view.container.querySelector(".usage-overview-headline > p")!;
    expect(subline).toHaveTextContent("6 requests");
    expect(subline).toHaveTextContent("API estimate");
    expect(subline).toHaveTextContent("priced 4 of 6");
    expect(screen.getByRole("button", { name: "About this estimate" }))
      .toHaveAccessibleDescription(/covers 4 of 6 requests/u);

    const providers = within(screen.getByLabelText("Estimated cost by provider")).getAllByRole("article");
    expect(providers.map((provider) => provider.getAttribute("data-provider"))).toEqual(["claude", "codex"]);
    expect(providers[0]).toHaveTextContent("Claude4 requests$12.50");
    expect(providers[0]).toHaveTextContent("Partial · 90.9% of cost · 3K tokens");
    expect(providers[1]).toHaveTextContent("Codex2 requests$1.25");
    expect(providers[1]).toHaveTextContent("Partial · 9.1% of cost · 1K tokens");
    expect(view.container.querySelector(
      '.usage-overview-providers .usage-provider-mark[data-provider-id="claude"]',
    )).toHaveAttribute("data-provider-icon-kind", "official");
    expect(view.container.querySelector(
      '.usage-overview-providers .usage-provider-mark[data-provider-id="claude"]',
    )).toHaveStyle({ "--provider-icon-size": "16px" });

    expect(screen.getByRole("img", { name: /^Daily estimated cost by provider/u })).toBeVisible();
    expect(view.container.querySelector(".usage-overview-chart-svg text, .usage-overview-chart-svg circle")).toBeNull();
    expect([...view.container.querySelectorAll(".usage-overview-chart-axis > span")]
      .map((tick) => tick.textContent)).toEqual(["$15", "$10", "$5", "0"]);

    const totals = screen.getByRole("region", { name: "Usage totals" });
    expect([...totals.querySelectorAll(".usage-overview-total > span")].map((label) => label.textContent))
      .toEqual(["Processed tokens", "Reported input", "Cached input", "Output", "Cache savings", "Requests"]);
    expect(within(totals).getByText("$2.40")).toBeVisible();
    expect(within(totals).getByText("6", { exact: true })).toBeVisible();
    expect(within(totals).getByText("25s active runtime · 4 completed · 1 failed · 1 interrupted")).toBeVisible();
    expect(within(totals).getAllByText("Measured for 5 of 6 requests")).toHaveLength(2);
    expect(within(totals).getByText("Measured for 3 of 6 requests · 120 reported cache writes")).toBeVisible();
    expect(within(totals).getByText("Measured for 5 of 6 requests · includes 40 reasoning")).toBeVisible();
    expect(within(totals).queryByText(/All providers/u)).toBeNull();

    const types = screen.getByRole("region", { name: "Cost by type" });
    expect([...types.querySelectorAll(".usage-overview-share-legend > li")].map((item) => item.textContent))
      .toEqual(["Uncached input$6.0043.6%", "Cache read$0.755.5%", "Cache write$0.503.6%", "Output$6.5047.3%"]);
    expect(types.querySelectorAll(".usage-overview-share-bar > i")).toHaveLength(4);
    expect(screen.queryByRole("region", { name: "Tokens by type" })).toBeNull();

    const table = screen.getByRole("region", { name: "Model usage table" });
    expect(table).toHaveAttribute("tabindex", "0");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent))
      .toEqual(["Rank#", "Model", "Cost", "Share", "Tokens", "Requests"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").querySelector("strong")!.textContent))
      .toEqual(["claude-fable-5", "gpt-6.1-codex-high", "<synthetic>"]);
    expect(rows[0]).toHaveTextContent("1claude-fable-5Claude$12.5090.9%2.5K3");
    expect(rows[1]).toHaveTextContent("Codex · priced as gpt-6.1-codex");
    expect(rows[1]).toHaveTextContent("Partial$1.259.1%Partial1K2");
    expect(rows[2]).toHaveTextContent("3<synthetic>Claude · KimiUnpriced—5001");
    expect(screen.queryByText(/revision/u)).toBeNull();
    expect(view.container.querySelector(
      '.usage-overview-model .usage-provider-mark[data-provider-id="claude"]',
    )).toHaveStyle({ "--provider-icon-size": "14px" });
    expect(rows[2]!.querySelector(".usage-overview-model-meter")).toBeNull();
    expect(rows[0]!.querySelector<HTMLElement>(".usage-overview-model-meter > i")!.style.width)
      .toBe("100%");
    expect(rows[1]!.querySelector<HTMLElement>(".usage-overview-model-meter > i")!.style.width)
      .toBe("10%");

    expect(screen.getByText(/no prompts, files, credentials, or new telemetry/iu)).toBeVisible();
    const estimate = screen.getByText(/Prices: LiteLLM model price list, updated 3 hours ago · 1,912 models\./u);
    expect(estimate).toHaveTextContent("API estimate, not a bill.");
    expect(estimate).toHaveTextContent("not what a subscription charges");
    expect(estimate).toHaveTextContent("The estimate covers 4 of 6 requests.");
  });

  it("renders the Tokens tab from the same dashboard without asking the runtime again", async () => {
    const request = requestFor();
    const view = render(overview({ request }));
    await screen.findByRole("heading", { name: "Daily cost" });

    view.rerender(overview({ request, metric: "tokens" }));

    expect(screen.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Daily cost" })).toBeNull();
    expect(screen.getByRole("region", { name: "Tokens" })).toHaveAttribute("data-metric", "tokens");
    expect(headline(view.container)).toHaveTextContent(/^4K$/u);
    const subline = view.container.querySelector(".usage-overview-headline > p")!;
    expect(subline).toHaveTextContent("Processed tokens");
    expect(subline).toHaveTextContent("measured for 5 of 6 requests");
    expect(subline).not.toHaveTextContent("API estimate");
    expect(screen.queryByRole("button", { name: "About this estimate" })).toBeNull();

    const providers = within(screen.getByLabelText("Measured tokens by provider")).getAllByRole("article");
    expect(providers[0]).toHaveTextContent("Claude4 requests3K");
    expect(providers[0]).toHaveTextContent("75% of tokens · $12.50");
    expect(providers[1]).toHaveTextContent("Codex2 requests1K");
    expect(providers[1]).toHaveTextContent("Partial · 25% of tokens · $1.25");
    expect(screen.getByRole("img", { name: /^Daily measured tokens by provider/u })).toBeVisible();

    const types = screen.getByRole("region", { name: "Tokens by type" });
    expect([...types.querySelectorAll(".usage-overview-share-legend > li")].map((item) => item.textContent))
      .toEqual(["Uncached input1.78K50.9%", "Cache read90025.7%", "Cache write1203.4%", "Output70020%"]);
    expect(screen.queryByRole("region", { name: "Cost by type" })).toBeNull();

    const table = screen.getByRole("region", { name: "Model usage table" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("1claude-fable-5Claude$12.5062.5%2.5K3");
    expect(rows[2]).toHaveTextContent("Unpriced12.5%5001");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("says why cost cannot be estimated and falls back to measured tokens", async () => {
    const request = requestFor(unpricedDashboard);
    const view = render(overview({ request }));

    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Cost can't be estimated right now");
    expect(note).toHaveTextContent("The model price list could not be downloaded and no saved copy exists. Showing measured tokens instead.");
    expect(screen.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Daily cost" })).toBeNull();
    expect(headline(view.container)).toHaveTextContent(/^4K$/u);
    expect(view.container.querySelector(".usage-overview")).not.toHaveTextContent("$");
    expect(view.container.querySelector(".usage-overview")).not.toHaveTextContent("API estimate");
    expect(screen.queryByText("Cache savings")).toBeNull();
    expect(screen.getByRole("region", { name: "Tokens by type" })).toBeVisible();
    const table = screen.getByRole("region", { name: "Model usage table" });
    expect(within(table).queryByRole("columnheader", { name: "Cost" })).toBeNull();
    expect(within(table).queryByText("Unpriced")).toBeNull();
    const unavailable = screen.getByText(/Prices: LiteLLM model price list, unavailable\./u);
    expect(unavailable).toHaveTextContent("Cost unavailable.");
    expect(unavailable).toHaveTextContent("The model price list could not be downloaded and no saved copy exists.");

    view.rerender(overview({ request, metric: "tokens" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
  });

  it("separates models without a price from priced models that reported no token detail", async () => {
    const unpriced = usageDashboard();
    unpriced.totals.cost = cost(null, 0, 6);
    unpriced.providers = unpriced.providers.map((provider) => ({
      ...provider,
      cost: cost(null, 0, provider.requestCount),
    }));
    unpriced.models = unpriced.models.map((model) => ({
      ...model,
      cost: cost(null, 0, model.requestCount),
      pricedAs: model.providerId === "codex" ? model.pricedAs : null,
    }));
    const request = requestFor(() => unpriced);
    const view = render(overview({ request }));

    await screen.findByRole("heading", { name: "Daily cost" });
    expect(headline(view.container)).toHaveTextContent(/^No estimate$/u);
    expect(view.container.querySelector(".usage-overview-headline > p"))
      .toHaveTextContent("6 requestsno request in this range could be priced");
    expect(screen.queryByRole("button", { name: "About this estimate" })).toBeNull();
    const providers = within(screen.getByLabelText("Estimated cost by provider")).getAllByRole("article");
    expect(providers[0]).toHaveTextContent("Unpriced · 3K tokens");
    expect(providers[1]).toHaveTextContent("No estimate · 1K tokens");
    const rows = within(screen.getByRole("region", { name: "Model usage table" })).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.querySelector("td.is-primary")!.textContent))
      .toEqual(["Unpriced", "No estimate", "Unpriced"]);

    view.rerender(overview({ request, metric: "tokens", hiddenProviderIds: new Set(["codex"]) }));
    expect(within(screen.getByLabelText("Measured tokens by provider")).getByRole("article"))
      .toHaveTextContent("100% of tokens · unpriced");
    view.rerender(overview({ request, hiddenProviderIds: new Set(["codex"]) }));
    expect(headline(view.container)).toHaveTextContent(/^Unpriced$/u);
  });

  it("recomputes figures from the visible providers and marks all-provider figures", async () => {
    const user = userEvent.setup();
    const request = requestFor();
    const view = render(overview({ request, hiddenProviderIds: new Set(["claude"]) }));

    await screen.findByRole("heading", { name: "Daily cost" });
    expect(headline(view.container)).toHaveTextContent(/^\$1\.25$/u);
    const subline = view.container.querySelector(".usage-overview-headline > p")!;
    expect(subline).toHaveTextContent("2 requests");
    expect(subline).toHaveTextContent("priced 1 of 2");
    const providers = within(screen.getByLabelText("Estimated cost by provider")).getAllByRole("article");
    expect(providers).toHaveLength(1);
    expect(providers[0]).toHaveTextContent("Partial · 100% of cost · 1K tokens");
    expect(view.container.querySelector('.usage-overview-chart-series[data-provider="claude"]')).toBeNull();
    expect(view.container.querySelector('.usage-overview-chart-series[data-provider="codex"]')).not.toBeNull();

    const totals = screen.getByRole("region", { name: "Usage totals" });
    expect(within(totals).getByText("2", { exact: true })).toBeVisible();
    expect(within(totals).getByText("5s active runtime")).toBeVisible();
    expect(within(totals).queryByText(/completed/u)).toBeNull();
    expect(within(totals).getByText("Measured for 1 of 2 requests")).toBeVisible();
    expect(within(totals).getAllByText(/^All providers/u)).toHaveLength(4);
    expect(within(screen.getByRole("region", { name: "Cost by type" })).getByText("All providers · API estimate"))
      .toBeVisible();

    const models = within(screen.getByRole("region", { name: "Model usage table" })).getAllByRole("row");
    expect(models).toHaveLength(2);
    expect(models[1]).toHaveTextContent("gpt-6.1-codex-high");
    expect(models[1]).toHaveTextContent("100%");

    await user.click(screen.getByRole("button", { name: "Day" }));
    const days = screen.getByRole("region", { name: "Day usage table" });
    expect(within(days).getAllByRole("columnheader").map((header) => header.textContent))
      .toEqual(["Day", "Codex", "Total cost", "Tokens", "Requests"]);
    const dayRows = within(days).getAllByRole("row").slice(1);
    expect(dayRows.map((row) => row.textContent)).toEqual([
      "Jun 30, 2026$1.25$1.251K1",
      "Jun 27, 2026No estimateNo estimateUnavailable1",
    ]);

    view.rerender(overview({ request, hiddenProviderIds: new Set(["claude", "codex"]) }));
    expect(screen.getByRole("heading", { name: "No usage for the selected providers" })).toBeVisible();
    expect(screen.getByText("All 2 providers with usage in this range are hidden by the provider filter."))
      .toBeVisible();
    expect(screen.queryByRole("region", { name: "Usage totals" })).toBeNull();

    view.rerender(overview({ request, hiddenProviderIds: new Set(["kimi"]) }));
    expect(headline(view.container)).toHaveTextContent(/^\$13\.75$/u);
    expect(screen.queryByText(/All providers/u)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the last figures while a new range loads and ignores a late response for an old range", async () => {
    const { pending, request } = deferredRequests();
    const view = render(overview({ request }));

    expect(screen.getByRole("status", { name: "Loading usage" })).toBeVisible();
    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).not.toHaveAttribute("data-refreshing");
    expect(root(view.container)).toHaveAttribute("aria-busy", "false");

    view.rerender(overview({ request, days: 7 }));
    expect(pending.map(({ days }) => days)).toEqual([30, 7]);
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).toHaveAttribute("data-refreshing", "true");
    expect(root(view.container)).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("status", { name: "Loading usage" })).toBeNull();

    view.rerender(overview({ request, days: 90 }));
    expect(pending.map(({ days }) => days)).toEqual([30, 7, 90]);
    await act(async () => pending[1]!.resolve(dashboardResult(withTotalCost(7, 1))));
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).toHaveAttribute("data-refreshing", "true");

    await act(async () => pending[2]!.resolve(dashboardResult(withTotalCost(90, 99.5))));
    expect(headline(view.container)).toHaveTextContent("$99.50");
    expect(root(view.container)).not.toHaveAttribute("data-refreshing");
    expect(root(view.container)).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("slider", { name: "Explore daily cost chart" }))
      .toHaveAttribute("aria-valuemax", "90");
  });

  it("reloads the same range when the refresh token changes", async () => {
    const { pending, request } = deferredRequests();
    const view = render(overview({ request }));
    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));

    view.rerender(overview({ request, refreshToken: 1 }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0]).toMatchObject({
      type: "usage.dashboard.get",
      payload: { days: 30 },
    });
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).toHaveAttribute("data-refreshing", "true");
    await act(async () => pending[1]!.resolve(dashboardResult(withTotalCost(30, 20))));
    expect(headline(view.container)).toHaveTextContent("$20.00");

    view.rerender(overview({ request, refreshToken: 1, metric: "tokens" }));
    view.rerender(overview({ request, refreshToken: 1, hiddenProviderIds: new Set(["codex"]) }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps same-range figures under the error when a refresh fails and drops them for another range", async () => {
    const user = userEvent.setup();
    const { pending, request } = deferredRequests();
    const view = render(overview({ request }));
    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));

    view.rerender(overview({ request, refreshToken: 1 }));
    await act(async () => pending[1]!.reject(new Error("Database is busy")));
    expect(screen.getByRole("alert")).toHaveTextContent("Usage could not be loadedDatabase is busy");
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).not.toHaveAttribute("data-refreshing");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(request).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => pending[2]!.resolve(dashboardResult(usageDashboard(30))));

    view.rerender(overview({ request, refreshToken: 1, days: 7 }));
    await act(async () => pending[3]!.reject(new Error("Database is busy")));
    expect(screen.getByRole("alert")).toHaveTextContent("Database is busy");
    expect(view.container.querySelector(".usage-overview-headline")).toBeNull();
  });

  it("reports busy state for loads, refreshes, failures and unmount", async () => {
    const { pending, request } = deferredRequests();
    const onBusyChange = vi.fn();
    const view = render(overview({ request, onBusyChange }));
    expect(onBusyChange.mock.calls).toEqual([[true]]);

    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);

    view.rerender(overview({ request, onBusyChange, refreshToken: 1 }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true]]);
    await act(async () => pending[1]!.reject(new Error("Database is busy")));
    expect(onBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);

    view.rerender(overview({ request, onBusyChange, refreshToken: 2 }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => pending[2]!.resolve(dashboardResult(usageDashboard(30))));
    expect(onBusyChange).toHaveBeenCalledTimes(6);
  });

  it("plots and announces cost on Cost and tokens on Tokens with keyboard day selection", async () => {
    const user = userEvent.setup();
    const request = requestFor();
    const view = render(overview({ request }));
    await screen.findByRole("heading", { name: "Daily cost" });

    const costExplorer = screen.getByRole("slider", { name: "Explore daily cost chart" });
    expect(costExplorer).toHaveAttribute("aria-valuenow", "30");
    expect(costExplorer).toHaveAttribute("aria-valuetext", "Jun 30, 2026, $13.75 estimated cost, partial");
    expect(view.container.querySelector('.usage-overview-chart-partial-point[data-provider="claude"]'))
      .not.toBeNull();
    costExplorer.focus();
    await waitFor(() => expect(screen.getByText("* Partial estimate")).toBeVisible());
    const tooltip = view.container.querySelector(".usage-overview-chart-tooltip")!;
    expect(tooltip).toHaveTextContent("Jun 30, 2026Claude$12.50*Codex$1.25Total estimate$13.75*");
    expect(tooltip.querySelector('.usage-provider-mark[data-provider-id="claude"]'))
      .toHaveStyle({ "--provider-icon-size": "14px" });
    await user.keyboard("[ArrowLeft]");
    expect(costExplorer).toHaveAttribute("aria-valuenow", "29");
    expect(costExplorer).toHaveAttribute("aria-valuetext", "Jun 29, 2026, $0.00 estimated cost");
    await user.keyboard("[ArrowLeft][ArrowLeft]");
    expect(costExplorer).toHaveAttribute("aria-valuetext", "Jun 27, 2026, cost unavailable");
    await user.keyboard("[Home]");
    expect(costExplorer).toHaveAttribute("aria-valuenow", "1");
    await user.keyboard("[End]");
    expect(costExplorer).toHaveAttribute("aria-valuenow", "30");
    expect(within(view.container.querySelector("table.visually-hidden")!).getByText("Daily estimated cost by provider"))
      .toBeInTheDocument();

    view.rerender(overview({ request, metric: "tokens" }));
    const tokenExplorer = screen.getByRole("slider", { name: "Explore daily token chart" });
    expect(tokenExplorer).toHaveAttribute("aria-valuetext", "Jun 30, 2026, 4K measured tokens");
    expect(view.container.querySelector(".usage-overview-chart-partial-point")).toBeNull();
    expect(view.container.querySelector(".usage-overview-chart-tooltip"))
      .toHaveTextContent("Claude3KCodex1KTotal measured4K");
    expect([...view.container.querySelectorAll(".usage-overview-chart-axis > span")]
      .map((tick) => tick.textContent)).toEqual(["3K", "2K", "1K", "0"]);
    expect(view.container.querySelectorAll(".usage-overview-chart-labels > span")).toHaveLength(3);
  });

  it("shows the skeleton, then ignores an obsolete response after going offline", async () => {
    const { pending, request } = deferredRequests();
    const view = render(overview({ request }));

    expect(screen.getByRole("status", { name: "Loading usage" })).toBeVisible();
    expect(screen.getByText(/Aggregating local turn records/u)).toBeVisible();
    expect(root(view.container)).toHaveAttribute("aria-busy", "true");
    view.rerender(overview({ request, status: "offline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Usage is unavailable while the local service is offline",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(screen.queryByRole("status", { name: "Loading usage" })).toBeNull();
    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));
    expect(screen.queryByRole("heading", { name: "Daily cost" })).toBeNull();
  });

  it("waits while connecting and reloads when the connection comes back", async () => {
    const { pending, request } = deferredRequests();
    const view = render(overview({ request, status: "connecting" }));
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeVisible();
    expect(request).not.toHaveBeenCalled();

    view.rerender(overview({ request }));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!.resolve(dashboardResult(usageDashboard(30))));
    expect(headline(view.container)).toHaveTextContent("$13.75");

    view.rerender(overview({ request, status: "offline" }));
    expect(screen.getByRole("alert")).toHaveTextContent("local service is offline");
    expect(view.container.querySelector(".usage-overview-headline")).toBeNull();

    view.rerender(overview({ request }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(headline(view.container)).toHaveTextContent("$13.75");
    expect(root(view.container)).toHaveAttribute("data-refreshing", "true");
    await act(async () => pending[1]!.resolve(dashboardResult(withTotalCost(30, 20))));
    expect(headline(view.container)).toHaveTextContent("$20.00");
  });

  it("distinguishes a measured zero from unavailable provider tokens", async () => {
    const measuredZero = usageDashboard();
    measuredZero.totals.processedTokens = metric(0, 6, 6);
    measuredZero.providers = measuredZero.providers.map((provider) => ({
      ...provider,
      processedTokens: metric(0, provider.requestCount, provider.requestCount),
    }));
    const view = render(overview({ metric: "tokens", request: requestFor(() => measuredZero) }));

    await screen.findByRole("heading", { name: "Daily processed tokens" });
    const provider = view.container.querySelector(".usage-overview-providers article")!;
    expect(provider).toHaveTextContent("0 measured tokens · share unavailable");
    expect(provider).not.toHaveTextContent("Token total unavailable");
    expect(headline(view.container)).toHaveTextContent(/^0$/u);
  });

  it("replaces the token cells with one plain line when no token metric is reported", async () => {
    const unreported = unpricedDashboard();
    unreported.totals.processedTokens = metric(null, 0, 6);
    unreported.tokens = {
      input: metric(null, 0, 6),
      cachedInput: metric(null, 0, 6),
      cacheWriteInput: metric(null, 0, 6),
      output: metric(null, 0, 6),
      reasoningOutput: metric(null, 0, 6),
    };
    const view = render(overview({ metric: "tokens", request: requestFor(() => unreported) }));

    const totals = await screen.findByRole("region", { name: "Usage totals" });
    expect(totals.querySelector(".usage-overview-totals-grid")).toHaveClass("is-requests-only");
    expect(within(totals).getByText("Token totals aren't reported by these providers yet.")).toBeVisible();
    expect(within(totals).queryByText("Unavailable")).toBeNull();
    expect(within(totals).queryByText("No defensible total available")).toBeNull();
    const cells = view.container.querySelectorAll(".usage-overview-total");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveClass("is-hero");
    expect(cells[0]).toHaveTextContent(/^Requests6/u);
    expect(headline(view.container)).toHaveTextContent(/^Unavailable$/u);
    expect(screen.queryByRole("region", { name: "Tokens by type" })).toBeNull();
  });

  it("keeps every metric cell while any token metric has data", async () => {
    const partial = usageDashboard();
    partial.totals.processedTokens = metric(null, 0, 6);
    partial.tokens = { ...partial.tokens, input: metric(null, 0, 6), cachedInput: metric(null, 0, 6) };
    const view = render(overview({ metric: "tokens", request: requestFor(() => partial) }));

    const totals = await screen.findByRole("region", { name: "Usage totals" });
    expect(totals.querySelector(".usage-overview-totals-grid")).not.toHaveClass("is-requests-only");
    expect(view.container.querySelectorAll(".usage-overview-total")).toHaveLength(6);
    expect(view.container.querySelector(".usage-overview-total.is-hero")).toBeNull();
    expect(within(totals).getAllByText("Unavailable")).toHaveLength(3);
    expect(within(totals).getAllByText("No defensible total available")).toHaveLength(2);
    expect(within(totals).getByText("No defensible total available · 120 reported cache writes")).toBeVisible();
  });

  it("shows every active period newest first in Day mode with keyboard-reachable tables", async () => {
    const historical = usageDashboard();
    const last = historical.daily.at(-1)!;
    historical.daily = historical.daily.map((day, index) => index < 10
      ? { ...last, date: day.date }
      : {
          ...day,
          requestCount: 0,
          completedCount: 0,
          failedCount: 0,
          cancelledCount: 0,
          interruptedCount: 0,
          runtime: zero(),
          processedTokens: zero(),
          cost: zero(),
          providers: [],
        });
    const user = userEvent.setup();
    render(overview({ request: requestFor(() => historical) }));

    await screen.findByRole("heading", { name: "Daily cost" });
    const day = screen.getByRole("button", { name: "Day" });
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    day.focus();
    await user.keyboard("[Enter]");
    expect(day).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("region", { name: "Day usage table" });
    expect(table).toHaveClass("is-day-mode");
    expect(table).toHaveAttribute("tabindex", "0");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent))
      .toEqual(["Day", "Claude", "Codex", "Total cost", "Tokens", "Requests"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(11);
    expect(rows[1]).toHaveTextContent("Jun 10, 2026Partial$12.50$1.25Partial$13.754K5");
    expect(rows[10]).toHaveTextContent("Jun 1, 2026");
    expect(screen.queryByRole("row", { name: /Jun 30, 2026/u })).toBeNull();
  });

  it("shows explicit empty and error states with a retry action", async () => {
    const request = vi.fn<Request>()
      .mockResolvedValueOnce(dashboardResult(emptyDashboard()))
      .mockRejectedValue(new Error("Database is busy"));
    const user = userEvent.setup();
    const view = render(overview({ request }));

    expect(await screen.findByRole("heading", {
      name: "No terminal requests in this range",
    })).toBeVisible();
    expect(screen.getByText("Usage will appear after Inertia records a completed, failed, cancelled, or interrupted terminal agent turn.")).toBeVisible();
    view.unmount();
    render(overview({ request }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Database is busy");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveClass("secondary-button");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it("rejects an unexpected result kind as a load failure", async () => {
    const request = vi.fn<Request>(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "git.action", message: "Not a dashboard" },
    }));
    render(overview({ request }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("The local service returned an unexpected usage response.");
  });

  it("styles the overview from tokens with quiet refresh dimming and no source comments", () => {
    const css = readSourceText("src/renderer/src/components/usage/UsageOverview.css");
    const rules = parseCssRules(css);
    expect(css).not.toMatch(/\/\*/u);
    expect(css).not.toMatch(/filter: blur|rgba?\(|hsl/u);
    expect(css.replace(/--usage-series-[a-z]+: #[0-9a-f]{6};/gu, "")).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(declarationsFor(rules, ".usage-overview-headline > strong").get("font-size"))
      .toBe("calc(var(--text-xl) * 1.5)");
    expect(declarationsFor(rules, ".usage-overview-headline > strong").get("font-weight")).toBe("600");
    expect(declarationsFor(rules, ".usage-overview").get("font-variant-numeric")).toBe("tabular-nums");
    expect(declarationsFor(rules, '.usage-overview[data-refreshing="true"] .usage-overview-figure').get("opacity"))
      .toBe("0.4");
    expect(declarationsFor(
      rules,
      '.usage-overview[data-refreshing="true"] .usage-overview-figure',
      "@media (prefers-reduced-motion: no-preference)",
    ).get("transition-delay")).toBe("150ms");
    expect(declarationsFor(rules, ".usage-overview-error .secondary-button").get("margin-left")).toBe("auto");
    expect(css).toMatch(/var\(--usage-provider-series, var\(--text-muted\)\)/u);
    for (const provider of ["codex", "claude", "cursor", "kimi", "opencode", "antigravity", "grok"]) {
      expect(css).toContain(`.usage-overview [data-provider="${provider}"] { --usage-provider-series: var(--usage-series-${provider}); }`);
    }
  });
});
