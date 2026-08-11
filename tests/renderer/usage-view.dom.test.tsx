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
    await waitFor(() => expect(screen.queryByText("Activity over time")).toBeNull());
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
    render(<UsageView status="online" request={request} />);

    expect(await screen.findByRole("heading", { name: "Activity over time" })).toBeVisible();
    const totals = screen.getByRole("region", { name: "Usage totals" });
    expect(within(totals).getByText("6", { exact: true })).toBeVisible();
    expect(within(totals).getByText("Unavailable", { exact: true })).toBeVisible();
    expect(within(totals).getByText(/1 interrupted/u)).toBeVisible();
    expect(screen.getByText(/Token totals are partial/u)).toBeVisible();
    expect(screen.getByText("<synthetic>", { exact: true })).toBeVisible();
    expect(screen.getByText(/Claude · Kimi/u)).toBeVisible();
    expect(screen.getByText(/No prompts, files, credentials, or new telemetry/u)).toBeVisible();
    expect(screen.getByLabelText("Model usage table")).toHaveAttribute(
      "tabindex",
      "0",
    );

    const tokens = screen.getByRole("button", { name: "Tokens" });
    await user.click(tokens);
    expect(tokens).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Gaps are unavailable totals/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      type: "usage.dashboard.get",
      payload: { days: 7 },
    });
    expect(screen.getByRole("button", { name: "7 days" }))
      .toHaveAttribute("aria-pressed", "true");
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
