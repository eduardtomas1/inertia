import { vi } from "vitest";

import type {
  ConversationShell,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import type { WatcherFeedItem, WatcherLinkView } from "../../src/shared/watcher";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING } from "../../src/shared/watcher";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { WatcherSurfaceModel } from "../../src/renderer/src/components/watcher/watcherContext";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { indexWatcherLinks } from "../../src/renderer/src/utils/watcherLinks";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const WATCHED_ID = "22222222-2222-4222-8222-222222222222";
export const WATCHER_ID = "33333333-3333-4333-8333-333333333333";
export const LINK_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_WATCHED_ID = "55555555-5555-4555-8555-555555555555";
export const NOW = "2026-10-19T10:42:00.000Z";

export function wakeId(sequence: number): string {
  return `66666666-6666-4666-8666-${String(sequence).padStart(12, "0")}`;
}

export const project: Project = {
  id: PROJECT_ID,
  name: "Studio",
  path: "/workspace/studio",
  normalizedPath: "/workspace/studio",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: "",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#6366f1",
  status: "ready",
  createdAt: NOW,
  updatedAt: NOW,
};

export function shell(
  id: string,
  title: string,
  overrides: Partial<ConversationShell> = {},
): ConversationShell {
  const providerId = overrides.providerId ?? "codex";
  return {
    id,
    projectId: PROJECT_ID,
    title,
    providerId,
    modelSelection: { ...providerNativeModelSelection({ providerId }), modelId: "fixture-model" },
    continuationIdentity: null,
    model: "fixture-model",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: NOW,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

export function link(overrides: Partial<WatcherLinkView> = {}): WatcherLinkView {
  return {
    id: LINK_ID,
    watcherConversationId: WATCHER_ID,
    watchedConversationId: WATCHED_ID,
    projectId: PROJECT_ID,
    preset: "reviewer",
    instructions: "",
    sharing: { ...DEFAULT_WATCHER_SHARING },
    budgets: { ...DEFAULT_WATCHER_BUDGETS },
    privateConnect: "inherit",
    delivery: "manual",
    status: "watching",
    pauseReason: null,
    pauseDetail: null,
    detachedReason: null,
    watchedTurnId: null,
    counters: { wakesThisTurn: 3, wakeAllowance: 30, wakesTotal: 7, eventsSeen: 9, eventsPending: 2, findingsTotal: 0 },
    lastWakeAt: NOW,
    quietSince: null,
    feedRevision: 1,
    latest: null,
    latestFindingAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function feedItem(sequence: number, overrides: Partial<WatcherFeedItem> = {}): WatcherFeedItem {
  const minute = String(30 + sequence).padStart(2, "0");
  return {
    wakeId: wakeId(sequence),
    sequence,
    watcherTurnId: `watcher-turn-${sequence}`,
    watchedTurnId: "watched-turn",
    trigger: "activity",
    outcome: "silent",
    state: "settled",
    eventsCovered: sequence,
    itemsTruncated: 0,
    itemsOmitted: 0,
    guardState: "clean",
    guardPaths: [],
    finding: null,
    delivery: null,
    resolvedBySequence: null,
    commandsDeclined: 0,
    createdAt: `2026-10-19T10:${minute}:00.000Z`,
    settledAt: `2026-10-19T10:${minute}:30.000Z`,
    ...overrides,
  };
}

export function finding(sequence: number, text: string, overrides: Partial<WatcherFeedItem> = {}): WatcherFeedItem {
  return feedItem(sequence, { outcome: "finding", finding: text, ...overrides });
}

type RequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];

/** The payload of a recorded command, for assertions. */
export function payloadOf(command: CommandWithoutId | undefined): Record<string, unknown> {
  return command && "payload" in command ? command.payload as Record<string, unknown> : {};
}

export function resultEventFor(result: RequestResult): ServerEvent {
  return { type: "request.result", requestId: "request", result } as ServerEvent;
}

/**
 * Records every command and answers through `respond`, which receives the
 * command and returns the result payload (or throws).
 */
export function recordingRequest(
  respond: (command: CommandWithoutId) => RequestResult | Promise<RequestResult>,
) {
  const commands: CommandWithoutId[] = [];
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    commands.push(command);
    return resultEventFor(await respond(command));
  });
  return { request, commands };
}

/** A runtime that answers watcher commands the way WP3b is expected to. */
export function watcherRuntime(options: {
  link?: () => WatcherLinkView;
  feed?: () => WatcherFeedItem[];
} = {}) {
  const currentLink = options.link ?? (() => link());
  const items = options.feed ?? (() => []);
  return recordingRequest((command) => {
    switch (command.type) {
      case "watcher.feed.get": {
        const current = currentLink();
        return { kind: "watcher.feed", linkId: current.id, feedRevision: current.feedRevision, items: items(), next: null };
      }
      case "watcher.pause":
        return { kind: "watcher.link", link: { ...currentLink(), status: "paused", pauseReason: "user" } };
      case "watcher.resume":
      case "watcher.wake":
      case "watcher.review":
      case "watcher.detach":
      case "watcher.update":
        return { kind: "watcher.link", link: currentLink() };
      case "watcher.note.deliver":
        return {
          kind: "watcher.delivery",
          linkId: command.payload.linkId,
          wakeId: command.payload.wakeId,
          delivery: { mode: command.payload.mode, state: "queued", detail: null, at: NOW },
        };
      case "watcher.note.dismiss":
        return {
          kind: "watcher.delivery",
          linkId: command.payload.linkId,
          wakeId: command.payload.wakeId,
          delivery: { mode: null, state: "dismissed", detail: null, at: NOW },
        };
      default:
        throw new Error(`Unexpected command ${command.type}`);
    }
  });
}

export function surfaceModel(
  overrides: Partial<WatcherSurfaceModel> & { watchers?: WatcherLinkView[]; shells?: ConversationShell[] } = {},
): WatcherSurfaceModel {
  const { watchers = [link()], shells = [shell(WATCHED_ID, "Refactor parser"), shell(WATCHER_ID, "Watcher · Reviewer · Refactor parser")], ...rest } = overrides;
  return {
    surface: "main",
    links: indexWatcherLinks(watchers),
    conversations: shells,
    projects: [project],
    providers: [],
    backendProfiles: [],
    providerLabels: { codex: "Team Codex" },
    primaryConversationId: WATCHED_ID,
    detachedConversationIds: new Set(),
    online: true,
    request: null,
    openAttachDialog: vi.fn(),
    showWatcher: vi.fn(),
    openWatcherChat: vi.fn(),
    ...rest,
  };
}
