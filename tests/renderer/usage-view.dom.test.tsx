import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  UsageView,
  type UsageViewProps,
} from "../../src/renderer/src/components/UsageView";
import type {
  ServerEvent,
  UsageDashboard,
  UsageMeasuredValue,
  UsageRangeDays,
} from "../../src/shared/contracts";

function metric(
  value: number | null,
  measuredRequests: number,
  totalRequests: number,
): UsageMeasuredValue {
  return {
    value,
    measuredRequests,
    totalRequests,
    coverage: measuredRequests === 0
      ? "unavailable"
      : measuredRequests === totalRequests ? "complete" : "partial",
  };
}

function dashboard(days: UsageRangeDays = 30): UsageDashboard {
  const end = new Date("2026-06-30T12:00:00.000Z");
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - days + index + 1);
    return {
      date: date.toISOString().slice(0, 10),
      requestCount: index === days - 1 ? 6 : 0,
      completedCount: index === days - 1 ? 4 : 0,
      failedCount: index === days - 1 ? 1 : 0,
      cancelledCount: 0,
      interruptedCount: index === days - 1 ? 1 : 0,
      runtime: index === days - 1
        ? metric(30_000, 5, 6)
        : { ...metric(0, 0, 0), coverage: "complete" as const },
      processedTokens: index === days - 1
        ? metric(2_100, 4, 6)
        : { ...metric(0, 0, 0), coverage: "complete" as const },
      providers: index === days - 1 ? [{
        key: "claude",
        providerId: "claude" as const,
        providerLabel: "Claude",
        requestCount: 6,
        runtime: metric(30_000, 5, 6),
        processedTokens: metric(2_100, 4, 6),
      }] : [],
    };
  });
  const startDate = daily[0]!.date;
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    range: {
      days,
      fromInclusive: `${startDate}T00:00:00.000Z`,
      toExclusive: "2026-07-01T00:00:00.000Z",
      startDate,
      endDate: "2026-06-30",
      timeZone: "UTC",
    },
    totals: {
      requestCount: 6,
      completedCount: 4,
      failedCount: 1,
      cancelledCount: 0,
      interruptedCount: 1,
      activeDays: 1,
      runtime: metric(30_000, 5, 6),
      processedTokens: metric(2_100, 4, 6),
    },
    daily,
    providers: [{
      key: "claude",
      providerId: "claude",
      providerLabel: "Claude",
      requestCount: 6,
      runtime: metric(30_000, 5, 6),
      processedTokens: metric(2_100, 4, 6),
    }],
    models: [{
      key: "synthetic",
      providerId: "claude",
      providerLabel: "Claude",
      requestCount: 6,
      runtime: metric(30_000, 5, 6),
      processedTokens: metric(2_100, 4, 6),
      model: "<synthetic>",
      backendProfileId: "preset:kimi",
      backendLabel: "Kimi",
      backendConfigurationRevision: 3,
    }],
    tokens: {
      input: metric(1_740, 5, 6),
      cachedInput: metric(420, 2, 6),
      cacheWriteInput: metric(50, 1, 6),
      output: metric(500, 5, 6),
      reasoningOutput: metric(30, 1, 6),
    },
    cost: {
      status: "unavailable",
      reason: "Inertia does not persist versioned model pricing or provider invoice charges.",
    },
  };
}

function result(value: UsageDashboard): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "usage.dashboard", dashboard: value },
  };
}

describe("UsageView", () => {
  it("shows loading and ignores an obsolete response after going offline", async () => {
    let resolveRequest!: (event: ServerEvent) => void;
    const request = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      resolveRequest = resolve;
    }));
    const view = render(<UsageView status="online" request={request} />);

    expect(screen.getByRole("status", { name: "Loading usage" })).toBeVisible();
    expect(screen.getByText(/Aggregating local turn records/u)).toBeVisible();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    view.rerender(<UsageView status="offline" request={request} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Usage is unavailable while the local service is offline",
    );
    resolveRequest(result(dashboard()));
    await waitFor(() => expect(screen.queryByText("Daily processed tokens")).toBeNull());
  });

  it("loads a truthful dashboard and keeps range and trend controls keyboard accessible", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (
      command: Parameters<UsageViewProps["request"]>[0],
    ) => {
      if (command.type !== "usage.dashboard.get") {
        throw new Error("Unexpected command");
      }
      return result(dashboard(command.payload.days));
    });
    const view = render(<UsageView status="online" request={request} />);

    expect(await screen.findByRole("heading", { name: "Daily processed tokens" })).toBeVisible();
    const totals = screen.getByRole("region", { name: "Usage totals" });
    expect(within(totals).getByText("6", { exact: true })).toBeVisible();
    expect(within(totals).getByText(/1 interrupted/u)).toBeVisible();
    expect(screen.getByText(/partial · measured across/u)).toBeVisible();
    expect(screen.getByText("<synthetic>", { exact: true })).toBeVisible();
    expect(screen.getByText(/Claude · Kimi · revision 3/u)).toBeVisible();
    expect(screen.getByRole("img", { name: /^Daily measured tokens by provider/u }))
      .toBeVisible();
    expect(view.container.querySelector(
      '.usage-chart-partial-point[data-provider="claude"]',
    )).toBeVisible();
    expect(view.container.querySelector(
      '.usage-provider-summary .usage-provider-mark[data-provider="claude"] svg',
    )).toBeVisible();
    expect(screen.getByText(/no prompts, files, credentials, or new telemetry/iu)).toBeVisible();
    expect(screen.getByRole("region", { name: "Model usage table" })).toHaveAttribute(
      "tabindex",
      "0",
    );

    const cost = screen.getByRole("button", { name: "Cost" });
    expect(cost).toHaveAttribute("aria-disabled", "true");
    expect(cost).toHaveAttribute("aria-describedby", "usage-cost-unavailable");
    cost.focus();
    expect(cost).toHaveFocus();
    const tokens = screen.getByRole("button", { name: "Tokens" });
    expect(tokens).toHaveAttribute("aria-pressed", "true");

    const explorer = screen.getByRole("slider", { name: "Explore daily token chart" });
    explorer.focus();
    await waitFor(() => expect(screen.getByText("* Partial coverage")).toBeVisible());
    await user.keyboard("[ArrowLeft]");
    expect(explorer).toHaveAttribute("aria-valuenow", "29");

    const day = screen.getByRole("button", { name: "Day" });
    day.focus();
    await user.keyboard("[Enter]");
    expect(day).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Day usage table" })).toBeVisible();

    const sevenDays = screen.getByRole("button", { name: "7 days" });
    sevenDays.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      type: "usage.dashboard.get",
      payload: { days: 7 },
    });
    expect(screen.getByRole("button", { name: "7 days" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("distinguishes a measured zero from unavailable provider tokens", async () => {
    const zero = dashboard();
    zero.totals.processedTokens = metric(0, 6, 6);
    zero.daily = zero.daily.map((day, index) => ({
      ...day,
      processedTokens: index === zero.daily.length - 1
        ? metric(0, 6, 6)
        : day.processedTokens,
      providers: day.providers.map((provider) => ({
        ...provider,
        processedTokens: metric(0, 6, 6),
      })),
    }));
    zero.providers = zero.providers.map((provider) => ({
      ...provider,
      processedTokens: metric(0, 6, 6),
    }));
    zero.models = zero.models.map((model) => ({
      ...model,
      processedTokens: metric(0, 6, 6),
    }));

    const view = render(<UsageView
      status="online"
      request={vi.fn(async () => result(zero))}
    />);
    const provider = await waitFor(() => {
      const element = view.container.querySelector(".usage-provider-summary article");
      expect(element).not.toBeNull();
      return element!;
    });

    expect(provider).toHaveTextContent("0 measured tokens · share unavailable");
    expect(provider).not.toHaveTextContent("Token total unavailable");
  });

  it("shows explicit empty and error states with a retry action", async () => {
    const empty = dashboard();
    empty.totals = {
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      interruptedCount: 0,
      activeDays: 0,
      runtime: metric(null, 0, 0),
      processedTokens: metric(null, 0, 0),
    };
    empty.daily = empty.daily.map((day) => ({
      ...day,
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      interruptedCount: 0,
      runtime: { ...metric(0, 0, 0), coverage: "complete" },
      processedTokens: { ...metric(0, 0, 0), coverage: "complete" },
      providers: [],
    }));
    empty.providers = [];
    empty.models = [];
    empty.tokens = {
      input: metric(null, 0, 0),
      cachedInput: metric(null, 0, 0),
      cacheWriteInput: metric(null, 0, 0),
      output: metric(null, 0, 0),
      reasoningOutput: metric(null, 0, 0),
    };
    const request = vi.fn()
      .mockResolvedValueOnce(result(empty))
      .mockRejectedValue(new Error("Database is busy"));
    const user = userEvent.setup();
    const view = render(<UsageView status="online" request={request} />);

    expect(await screen.findByRole("heading", {
      name: "No terminal requests in this range",
    })).toBeVisible();
    view.unmount();
    render(<UsageView status="online" request={request} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database is busy");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });
});
