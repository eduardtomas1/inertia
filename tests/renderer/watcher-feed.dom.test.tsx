import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { WatcherFeedItem } from "../../src/shared/watcher";
import { steerAvailable } from "../../src/shared/watcher-feed";
import { resetWatcherFeedMotion, WatcherFeed } from "../../src/renderer/src/components/watcher/WatcherFeed";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { createWatcherActions } from "../../src/renderer/src/hooks/useWatcherActions";
import { useWatcherFeed } from "../../src/renderer/src/hooks/useWatcherFeed";
import {
  LINK_ID,
  PROJECT_ID,
  WATCHED_ID,
  NOW,
  feedItem,
  finding,
  link,
  payloadOf,
  recordingRequest,
  watcherRuntime,
} from "./watcher-fixtures";

function FeedHarness({
  runtime,
  running = false,
  harnessId = "codex-app-server",
  revision = 1,
}: {
  runtime: Pick<ReturnType<typeof watcherRuntime>, "request">;
  running?: boolean;
  harnessId?: string;
  revision?: number;
}) {
  const actions = useMemo(() => createWatcherActions(runtime.request, LINK_ID), [runtime]);
  const feed = useWatcherFeed(LINK_ID, revision, actions);
  return (
    <WatcherFeed
      feed={feed}
      actions={actions}
      headingId="watcher-findings"
      linkId={LINK_ID}
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

beforeEach(() => resetWatcherFeedMotion());

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
    expect(entries[0]).toHaveTextContent(/Checked 2 times · 10:35–10:36 AM · nothing to report/u);
    expect(entries[2]).toHaveTextContent(/Checked once at 10:33 AM · nothing to report/u);
    expect(entries[2]).toHaveTextContent("Checkout check inconclusive");
    expect(entries[3]).toHaveTextContent("The check failed.");
    expect(within(entries[1]!).getByRole("article", { name: "Finding" })).toHaveTextContent("The parser drops the trailing token.");
  });

  it("shows how many read-only commands the watcher ran in each receipt and check", async () => {
    renderFeed([
      feedItem(3, { commandsRun: 2 }),
      feedItem(2),
      feedItem(1, { commandsRun: 1 }),
    ]);
    const list = await screen.findByRole("list", { name: "Watcher findings" });
    const [receipt] = within(list).getAllByRole("listitem").filter((item) => item.parentElement === list);
    expect(receipt).toHaveTextContent(/Checked 3 times · .* · nothing to report · ran 3 read-only commands/u);
    expect(receipt).toHaveTextContent("ran 1 read-only command");
  });

  it("moves focus to the card's own status after Send and reports the queued note", async () => {
    const runtime = renderFeed([finding(4, "Risky rename.")], { running: true });
    const card = await screen.findByRole("article", { name: "Finding" });
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    const status = within(card).getByRole("status");
    expect(status).toHaveFocus();
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(status).toHaveTextContent(/^Queued · sends after the current turn$/u));
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
      "Queue for next turnSends after the current turn",
      "Steer nowDelivers the note into the running turn",
    ]);
    // Rendered outside the scrolling feed, so the last card's menu is never clipped.
    expect(menu.closest(".watcher-feed")).toBeNull();
    expect(menu).toHaveClass("is-floating");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Steer now/u }));
    await waitFor(() => expect(payloadOf(steering.commands.find(({ type }) => type === "watcher.note.deliver")))
      .toMatchObject({ mode: "steer" }));
  });

  it.each([
    ["the watched chat is idle", { running: false }],
    ["the watched harness cannot be steered", { running: true, harnessId: "cursor-acp" }],
  ])("shows a plain Send without a menu when %s", async (_case, options) => {
    renderFeed([finding(4, "Queue only.")], options);
    const card = await screen.findByRole("article", { name: "Finding" });
    expect(within(card).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "More ways to send" })).not.toBeInTheDocument();
  });

  it("heads a card with its time and keeps the lifetime check number muted", async () => {
    renderFeed([finding(4, "A risk.")]);
    const card = await screen.findByRole("article", { name: "Finding" });
    const header = card.querySelector("header")!;
    expect(header.querySelector(".watcher-finding-heading")).toHaveTextContent(/^Finding· 10:34 AM$/u);
    expect(header.querySelector(".watcher-finding-meta")).toHaveTextContent(/^Check 4$/u);
  });

  it.each([
    ["queued", { mode: "queue", state: "queued", detail: null }, true, /^Queued · sends after the current turn$/u],
    ["sent", { mode: "queue", state: "sent", detail: null }, false, /^Sent \d{1,2}:\d{2}\s[AP]M · started the main chat's next turn$/u],
    ["sent after the turn", { mode: "queue", state: "sent", detail: "after the turn ended" }, false, /^Sent .+ · after the turn ended$/u],
    ["steered", { mode: "steer", state: "sent", detail: null }, true, /^Sent .+ · into the running turn$/u],
    ["fallback", { mode: "queue", state: "queued", detail: "The turn ended before the note arrived." }, true, /^Queued · the turn ended before the note arrived$/u],
  ] as const)("shows one status line for a %s note", async (_case, delivery, running, expected) => {
    renderFeed([finding(4, "A risk.", { delivery: { ...delivery, at: NOW } })], { running });
    const card = await screen.findByRole("article", { name: "Finding" });
    expect(within(card).getByRole("status")).toHaveTextContent(expected);
    expect(within(card).getByRole("status").children).toHaveLength(0);
  });

  it("replaces Not sent with the real delivery after an ambiguous timeout, reusing its id", async () => {
    let delivered: WatcherFeedItem["delivery"] = null;
    let attempts = 0;
    const runtime = recordingRequest((command) => {
      if (command.type === "watcher.feed.get") {
        return { kind: "watcher.feed", linkId: LINK_ID, feedRevision: 1, items: [finding(4, "Risky rename.", { delivery: delivered })], next: null };
      }
      if (command.type === "watcher.note.deliver") {
        attempts += 1;
        // The first request lands but its answer is lost.
        if (attempts === 1) {
          delivered = { mode: "queue", state: "queued", detail: null, at: NOW };
          throw new RuntimeCommandError("The local service did not answer in time.", "ambiguous");
        }
        throw new RuntimeCommandError("The local service did not answer in time.", "ambiguous");
      }
      throw new Error(`Unexpected command ${command.type}`);
    });
    const view = render(<FeedHarness runtime={runtime} running />);
    const card = await screen.findByRole("article", { name: "Finding" });
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent(/^Not sent · /u));
    // A retry reuses the same delivery id, so the runtime can't deliver twice.
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(attempts).toBe(2));
    const ids = runtime.commands.filter(({ type }) => type === "watcher.note.deliver").map((command) => payloadOf(command).deliveryId);
    expect(new Set(ids).size).toBe(1);
    await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent(/^Not sent · /u));
    // The next feed refresh carries the authoritative delivery.
    view.rerender(<FeedHarness runtime={runtime} running revision={2} />);
    await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent(/^Queued · sends after the current turn$/u));
    expect(within(card).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("plays a card's entrance once, not again after a remount", async () => {
    const first = renderFeed([finding(4, "A risk.")]);
    const card = await screen.findByRole("article", { name: "Finding" });
    expect(card).toHaveAttribute("data-enter", "true");
    act(() => { card.dispatchEvent(new Event("animationend", { bubbles: true })); });
    expect(card).not.toHaveAttribute("data-enter");
    void first;
    document.body.innerHTML = "";
    renderFeed([finding(4, "A risk.")]);
    expect(await screen.findByRole("article", { name: "Finding" })).not.toHaveAttribute("data-enter");
  });
});
