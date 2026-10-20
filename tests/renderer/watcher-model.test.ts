import { describe, expect, it } from "vitest";

import type { AppSnapshot } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { WATCHER_PRESET_LABELS } from "../../src/shared/watcher";
import { groupWatcherFeed, steerAvailable } from "../../src/shared/watcher-feed";
import { sidebarThreadView } from "../../src/renderer/src/utils/sidebarModel";
import { nestWatcherThreads } from "../../src/renderer/src/utils/watcherSidebar";
import {
  indexWatcherLinks,
  WATCHER_PRESET_NAMES,
  watcherAgentLabel,
  watcherEventsText,
} from "../../src/renderer/src/utils/watcherLinks";
import { applyWatcherLinkEvent } from "../../src/renderer/src/utils/runtimeSnapshotProjection";
import {
  OTHER_WATCHED_ID,
  WATCHED_ID,
  WATCHER_ID,
  feedItem,
  finding,
  link,
  project,
  shell,
} from "./watcher-fixtures";

const views = (ids: string[]) => ids.map((id) => sidebarThreadView(shell(id, `Chat ${id.slice(0, 4)}`), null));

describe("nestWatcherThreads", () => {
  it("moves an attached watcher under the chat it watches", () => {
    const nested = nestWatcherThreads(views([WATCHED_ID, WATCHER_ID, OTHER_WATCHED_ID]), [link()]);
    expect(nested.threads.map(({ conversation }) => conversation.id)).toEqual([WATCHED_ID, OTHER_WATCHED_ID]);
    expect(nested.watchersByParent.get(WATCHED_ID)?.conversation.id).toBe(WATCHER_ID);
  });

  it("keeps detached watchers and watchers of unlisted chats at the top level", () => {
    const detached = link({ status: "detached", detachedReason: "user", watchedConversationId: null });
    expect(nestWatcherThreads(views([WATCHED_ID, WATCHER_ID]), [detached]).threads).toHaveLength(2);
    const filtered = nestWatcherThreads(views([WATCHER_ID]), [link()]);
    expect(filtered.threads.map(({ conversation }) => conversation.id)).toEqual([WATCHER_ID]);
    expect(filtered.watchersByParent.size).toBe(0);
  });

  it("returns the threads unchanged without links", () => {
    const listed = views([WATCHED_ID, WATCHER_ID]);
    expect(nestWatcherThreads(listed, undefined).threads).toEqual(listed);
  });
});

describe("steer availability", () => {
  it("is offered only while the watched turn runs on a steerable harness", () => {
    expect(steerAvailable("codex-app-server", true)).toBe(true);
    expect(steerAvailable("opencode-sdk", true)).toBe(true);
    expect(steerAvailable("codex-app-server", false)).toBe(false);
    expect(steerAvailable("cursor-acp", true)).toBe(false);
    expect(steerAvailable(null, true)).toBe(false);
  });
});

describe("feed grouping", () => {
  it("folds consecutive quiet checks and lets findings and notices end a receipt", () => {
    const groups = groupWatcherFeed([
      feedItem(6),
      feedItem(5),
      finding(4, "The parser drops the trailing token."),
      feedItem(3),
      feedItem(2, { outcome: "failed" }),
      feedItem(1),
    ]);
    expect(groups.map((group) => group.kind === "receipts" ? `receipts:${group.count}` : group.item.outcome))
      .toEqual(["receipts:2", "finding", "receipts:1", "failed", "receipts:1"]);
  });
});

describe("watcher lookups", () => {
  it("index attached links by watched and watcher chat, ignoring detached ones", () => {
    const index = indexWatcherLinks([link(), link({
      id: "77777777-7777-4777-8777-777777777777",
      watcherConversationId: "88888888-8888-4888-8888-888888888888",
      watchedConversationId: null,
      status: "detached",
      detachedReason: "watched-deleted",
    })]);
    expect(index.byWatched.get(WATCHED_ID)?.id).toBe(link().id);
    expect(index.byWatcher.has(WATCHER_ID)).toBe(true);
    expect(index.activeCount).toBe(1);
  });

  it("keeps the renderer preset names equal to the shared labels", () => {
    expect(WATCHER_PRESET_NAMES).toEqual(WATCHER_PRESET_LABELS);
  });

  it("names the watcher's agent from the provider labels and its model", () => {
    expect(watcherAgentLabel(shell(WATCHER_ID, "Watcher"), { codex: "Team Codex" })).toBe("Team Codex fixture-model");
    expect(watcherEventsText(1)).toBe("1 event");
    expect(watcherEventsText(9)).toBe("9 events");
  });
});

describe("applyWatcherLinkEvent", () => {
  const snapshot = (): AppSnapshot => ({
    projects: [project],
    conversations: [],
    runs: [],
    providers: [],
    settings: defaultSettings,
    activeProjectId: project.id,
    activeConversationId: null,
  });

  it("adds, replaces and removes links without touching unchanged state", () => {
    const added = applyWatcherLinkEvent(snapshot(), { type: "watcher.link.updated", link: link() });
    expect(added.watchers).toEqual([link()]);
    expect(applyWatcherLinkEvent(added, { type: "watcher.link.updated", link: link() })).toBe(added);
    const paused = applyWatcherLinkEvent(added, {
      type: "watcher.link.updated",
      link: link({ status: "paused", pauseReason: "user" }),
    });
    expect(paused.watchers?.[0]?.status).toBe("paused");
    const removed = applyWatcherLinkEvent(paused, { type: "watcher.link.removed", linkId: link().id });
    expect(removed.watchers).toEqual([]);
    expect(applyWatcherLinkEvent(removed, { type: "watcher.link.removed", linkId: link().id })).toBe(removed);
  });
});
