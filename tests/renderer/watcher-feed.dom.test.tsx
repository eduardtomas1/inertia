import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it } from "vitest";

import type { WatcherFeedItem } from "../../src/shared/watcher";
import { steerAvailable } from "../../src/shared/watcher-feed";
import { WatcherFeed } from "../../src/renderer/src/components/watcher/WatcherFeed";
import { createWatcherActions } from "../../src/renderer/src/hooks/useWatcherActions";
import { useWatcherFeed } from "../../src/renderer/src/hooks/useWatcherFeed";
import {
  LINK_ID,
  PROJECT_ID,
  WATCHED_ID,
  feedItem,
  finding,
  link,
  payloadOf,
  watcherRuntime,
} from "./watcher-fixtures";

function FeedHarness({
  runtime,
  running = false,
  harnessId = "codex-app-server",
}: {
  runtime: ReturnType<typeof watcherRuntime>;
  running?: boolean;
  harnessId?: string;
}) {
  const actions = useMemo(() => createWatcherActions(runtime.request, LINK_ID), [runtime]);
  const feed = useWatcherFeed(LINK_ID, 1, actions);
  return (
    <WatcherFeed
      feed={feed}
      actions={actions}
      headingId="watcher-findings"
      projectRoot="/workspace/studio"
      projectId={PROJECT_ID}
      watchedConversationId={WATCHED_ID}
      watchedRunning={running}
      steerable={steerAvailable(harnessId, running)}
      online
    />
  );
}

function renderFeed(items: WatcherFeedItem[], options: { running?: boolean; harnessId?: string } = {}) {
  const runtime = watcherRuntime({ link: () => link(), feed: () => items });
  render(<FeedHarness runtime={runtime} {...options} />);
  return runtime;
}

describe("WatcherFeed", () => {
  it("folds quiet checks into receipts that a finding or failure ends", async () => {
    renderFeed([
      feedItem(6),
      feedItem(5),
      finding(4, "The parser drops the trailing token."),
      feedItem(3, { guardState: "inconclusive" }),
      feedItem(2, { outcome: "failed" }),
    ]);
    const list = await screen.findByRole("list", { name: "Watcher findings" });
    const entries = within(list).getAllByRole("listitem").filter((item) => item.parentElement === list);
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(["receipts", "finding", "receipts", "notice"]);
    expect(entries[0]).toHaveTextContent(/Checked 2 times since 10:35 AM · nothing to report/u);
    expect(entries[2]).toHaveTextContent(/Checked once at 10:33 AM · nothing to report/u);
    expect(entries[2]).toHaveTextContent("Checkout check inconclusive");
    expect(entries[3]).toHaveTextContent("The check failed.");
    expect(within(entries[1]!).getByRole("article", { name: "Finding" })).toHaveTextContent("The parser drops the trailing token.");
  });

  it("moves focus to the card's own status after Send and reports the queued note", async () => {
    const runtime = renderFeed([finding(4, "Risky rename.")], { running: true });
    const card = await screen.findByRole("article", { name: "Finding" });
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    const status = within(card).getByRole("status");
    expect(status).toHaveFocus();
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(status).toHaveTextContent("Queued · sends after the current turn"));
    expect(status).toHaveFocus();
    const deliver = runtime.commands.find(({ type }) => type === "watcher.note.deliver");
    expect(payloadOf(deliver)).toMatchObject({ linkId: LINK_ID, wakeId: finding(4, "").wakeId, mode: "queue" });
    expect(within(card).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("moves focus to the next card after Dismiss, and to the heading after the last one", async () => {
    const runtime = renderFeed([finding(5, "First."), finding(4, "Second.")]);
    const [first, second] = await screen.findAllByRole("article", { name: "Finding" });
    fireEvent.click(within(first!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(second).toHaveFocus());
    expect(screen.getAllByRole("article", { name: "Finding" })).toHaveLength(1);
    fireEvent.click(within(second!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Findings" })).toHaveFocus());
    expect(screen.queryByRole("article", { name: "Finding" })).not.toBeInTheDocument();
    expect(runtime.commands.filter(({ type }) => type === "watcher.note.dismiss")).toHaveLength(2);
  });

  it("offers Steer now only while the watched turn runs on a steerable harness", async () => {
    const steering = renderFeed([finding(4, "Steer me.")], { running: true });
    fireEvent.click(await screen.findByRole("button", { name: "More ways to send" }));
    const menu = await screen.findByRole("menu", { name: "More ways to send" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Queue for next turnWaits for the current turn to finish",
      "Steer nowDelivers the note into the running turn",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Steer now/u }));
    await waitFor(() => expect(payloadOf(steering.commands.find(({ type }) => type === "watcher.note.deliver")))
      .toMatchObject({ mode: "steer" }));
  });

  it.each([
    ["the watched chat is idle", { running: false }],
    ["the watched harness cannot be steered", { running: true, harnessId: "cursor-acp" }],
  ])("hides Steer now when %s", async (_case, options) => {
    renderFeed([finding(4, "Queue only.")], options);
    fireEvent.click(await screen.findByRole("button", { name: "More ways to send" }));
    const menu = await screen.findByRole("menu", { name: "More ways to send" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    expect(within(menu).queryByRole("menuitem", { name: /Steer now/u })).not.toBeInTheDocument();
  });
});
