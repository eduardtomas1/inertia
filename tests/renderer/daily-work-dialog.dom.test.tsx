import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DailyWorkDialog,
  dailyWorkCommand,
  type DailyWorkDialogProps,
} from "../../src/renderer/src/components/DailyWorkDialog";
import type {
  DailyWorkDashboard,
  ServerEvent,
  UsageMeasuredValue,
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
    coverage: totalRequests === 0
      ? "complete"
      : measuredRequests === 0
        ? "unavailable"
        : measuredRequests === totalRequests ? "complete" : "partial",
  };
}

function dashboard(): DailyWorkDashboard {
  return {
    generatedAt: "2026-08-17T12:00:00.000Z",
    date: "2026-08-17",
    range: {
      fromInclusive: "2026-08-17T00:00:00.000Z",
      toExclusive: "2026-08-18T00:00:00.000Z",
      timeZone: "UTC",
    },
    totals: {
      conversationCount: 2,
      turnCount: 3,
      activeTurnCount: 1,
      runtime: metric(5_400_000, 2, 2),
      processedTokens: metric(2_400, 1, 2),
    },
    providers: [{
      providerId: "codex",
      providerLabel: "Codex",
      turnCount: 2,
      activeTurnCount: 0,
      runtime: metric(5_400_000, 2, 2),
      processedTokens: metric(2_400, 1, 2),
    }, {
      providerId: "claude",
      providerLabel: "Claude",
      turnCount: 1,
      activeTurnCount: 1,
      runtime: metric(0, 0, 0),
      processedTokens: metric(0, 0, 0),
    }],
    conversations: [{
      conversationId: "conversation-active",
      projectId: "project-one",
      projectName: "Inertia",
      title: "Implement daily work",
      providerIds: ["codex", "claude"],
      createdToday: false,
      running: true,
      turnCount: 3,
      activeTurnCount: 1,
      lastActivityAt: "2026-08-17T11:30:00.000Z",
      runtime: metric(5_400_000, 2, 2),
      processedTokens: metric(2_400, 1, 2),
    }, {
      conversationId: "conversation-empty",
      projectId: "project-two",
      projectName: "Website",
      title: "New planning chat",
      providerIds: ["cursor"],
      createdToday: true,
      running: false,
      turnCount: 0,
      activeTurnCount: 0,
      lastActivityAt: "2026-08-17T09:00:00.000Z",
      runtime: metric(0, 0, 0),
      processedTokens: metric(0, 0, 0),
    }],
  };
}

function result(value: DailyWorkDashboard): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: { kind: "daily.work", dashboard: value },
  };
}

function renderDialog(
  props: Partial<DailyWorkDialogProps> = {},
): ReturnType<typeof render> & {
  request: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onOpenConversation: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async () => result(dashboard()));
  const onClose = vi.fn();
  const onOpenConversation = vi.fn();
  const view = render(<DailyWorkDialog
    status="online"
    request={request}
    onClose={onClose}
    onOpenConversation={onOpenConversation}
    {...props}
  />);
  return { ...view, request, onClose, onOpenConversation };
}

describe("DailyWorkDialog", () => {
  it("requests the current local day and renders totals, providers, and navigable conversations", async () => {
    const user = userEvent.setup();
    const view = renderDialog();

    expect(screen.getByRole("status", { name: "Loading daily work" })).toBeVisible();
    const dialog = await screen.findByRole("dialog", { name: "Daily work" });
    const mark = dialog.querySelector(".daily-work-mark");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("focusable", "false");
    expect(mark).toHaveAttribute("viewBox", "0 0 24 24");
    expect(mark).toHaveAttribute("width", "19");
    expect(mark?.querySelectorAll(".daily-work-mark-time")).toHaveLength(1);
    await waitFor(() => expect(view.request).toHaveBeenCalledTimes(1));
    const command = view.request.mock.calls[0]?.[0];
    expect(command).toMatchObject({ type: "daily.work.get" });
    if (command?.type !== "daily.work.get") throw new Error("Unexpected command");
    const today = new Date();
    expect(command.payload).toEqual({
      date: [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, "0"),
        String(today.getDate()).padStart(2, "0"),
      ].join("-"),
      fromInclusive: new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      ).toISOString(),
      toExclusive: new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() + 1,
      ).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });

    const totals = within(dialog).getByRole("region", { name: "Today’s totals" });
    expect(totals).toHaveTextContent("2.4K");
    expect(totals).toHaveTextContent("1.5h");
    expect(totals).toHaveTextContent("2");
    expect(dialog).toHaveTextContent("1 active turn is excluded from settled totals");
    expect(within(dialog).getByRole("heading", { name: "By provider" })).toBeVisible();
    expect(view.container.querySelectorAll(
      '.daily-work-provider-summary .usage-provider-mark[data-provider-id="codex"]',
    )).toHaveLength(1);

    const active = within(dialog).getByRole("button", { name: /Implement daily work/u });
    expect(active).toHaveTextContent("Running");
    expect(active).toHaveTextContent("Inertia");
    await user.click(active);
    expect(view.onOpenConversation).toHaveBeenCalledWith("conversation-active");

    expect(within(dialog).getByRole("button", { name: /New planning chat/u }))
      .toHaveTextContent("Created today");
  });

  it("renders each provider's settled token share against the day total", async () => {
    const shared = dashboard();
    shared.totals.processedTokens = metric(4_000, 2, 2);
    shared.providers[0]!.processedTokens = metric(3_000, 2, 2);
    shared.providers[1]!.processedTokens = metric(1_000, 1, 1);
    const view = renderDialog({ request: vi.fn(async () => result(shared)) });
    await screen.findByRole("dialog", { name: "Daily work" });

    const codex = await waitFor(() => {
      const card = view.container.querySelector(
        '.daily-work-provider-summary[data-provider="codex"]',
      );
      if (!card) throw new Error("Codex summary is not rendered yet");
      return card;
    });
    const claude = view.container.querySelector(
      '.daily-work-provider-summary[data-provider="claude"]',
    );
    expect(codex).toHaveTextContent("75%");
    expect(claude).toHaveTextContent("25%");
    expect(codex.querySelector(".daily-work-provider-meter > i"))
      .toHaveStyle({ width: "75%" });
  });

  it("marks provider shares unavailable when the day total is unmeasured", async () => {
    const unmeasured = dashboard();
    unmeasured.totals.processedTokens = metric(null, 0, 2);
    const view = renderDialog({ request: vi.fn(async () => result(unmeasured)) });
    await screen.findByRole("dialog", { name: "Daily work" });

    await waitFor(() => {
      expect(view.container.querySelectorAll(
        ".daily-work-provider-meter.is-unavailable",
      )).toHaveLength(2);
    });
    expect(view.container.querySelector(".daily-work-provider-share")).toBeNull();
  });

  it("distinguishes the running badge from the created-today badge", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Daily work" });

    const running = await waitFor(() => within(dialog).getByRole("button", {
      name: /Implement daily work/u,
    }));
    const created = within(dialog).getByRole("button", { name: /New planning chat/u });
    expect(running.querySelector(".daily-work-badge.is-running")).toHaveTextContent("Running");
    expect(created.querySelector(".daily-work-badge.is-running")).toBeNull();
    expect(created.querySelector(".daily-work-badge.is-new")).toHaveTextContent("Created today");
  });

  it("focuses the close control, closes on Escape, and restores prior focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = renderDialog();

    const close = screen.getByRole("button", { name: "Close daily work" });
    await waitFor(() => expect(close).toHaveFocus());
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("shows an offline error without issuing a request", async () => {
    const request = vi.fn<DailyWorkDialogProps["request"]>();
    renderDialog({ status: "offline", request });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Daily work is unavailable while the local service is offline",
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe("dailyWorkCommand", () => {
  it("uses local midnight boundaries", () => {
    const now = new Date(2026, 7, 17, 15, 30);
    expect(dailyWorkCommand(now).payload).toMatchObject({
      date: "2026-08-17",
      fromInclusive: new Date(2026, 7, 17).toISOString(),
      toExclusive: new Date(2026, 7, 18).toISOString(),
    });
  });
});
