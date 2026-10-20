import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING } from "../../src/shared/watcher";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { connectRuntime } from "../support/runtime-event-queue";
import { startTestRuntime } from "../support/test-runtime";

type Client = Awaited<ReturnType<typeof connectRuntime>>;

const runtimes: RunningRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start(root: string, generation: number): Promise<RunningRuntime> {
  const runtime = await startTestRuntime({
    dataDirectory: join(root, "data"),
    defaultWorkspacePath: join(root, "workspace"),
    enableProviders: false,
    runtimeGenerationId: `00000000-0000-4000-8000-00000000000${generation}:1`,
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
  });
  runtimes.push(runtime);
  return runtime;
}

async function welcome(client: Client): Promise<AppSnapshot> {
  const event = await client.events.next((candidate): candidate is Extract<ServerEvent, { type: "server.welcome" }> =>
    candidate.type === "server.welcome", "the welcome snapshot");
  return event.snapshot;
}

async function request(client: Client, type: string, payload: unknown): Promise<ServerEvent> {
  const requestId = randomUUID();
  client.socket.send(JSON.stringify({ type, requestId, payload }));
  return await client.events.next((event): event is ServerEvent =>
    (event.type === "request.ok" || event.type === "request.error" || event.type === "request.result")
    && event.requestId === requestId, `request ${type}`);
}

describe("watcher runtime wiring", () => {
  it("routes watcher commands to the real handler and recovers an interrupted check on restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-watcher-runtime-"));
    directories.push(root);
    mkdirSync(join(root, "workspace"));
    const first = await start(root, 1);
    const client = await connectRuntime(first.websocketUrl);
    expect((await welcome(client)).watchers).toEqual([]);
    expect(await request(client, "watcher.pause", { linkId: randomUUID() }))
      .toMatchObject({ type: "request.error", message: "This watcher is no longer attached." });
    client.socket.close();
    await first.close();
    runtimes.splice(0);

    const store = new RuntimeStore(join(root, "data", "inertia.sqlite"), join(root, "workspace"), { recoverInterruptedRuns: false });
    const project = store.createProject("Project", join(root, "workspace"));
    const watched = store.createConversation(project.id, "Main chat");
    const at = new Date().toISOString();
    const { link } = store.watcherLinks.createWithConversation({
      link: {
        id: randomUUID(), watchedConversationId: watched.id, preset: "reviewer", instructions: "",
        sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS }, privateConnect: "inherit",
      },
      conversation: {
        projectId: project.id,
        title: "Watcher · Reviewer · Main chat",
        options: {
          modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
          interactionMode: "plan", accessMode: "supervised",
        },
      },
    }, at);
    store.watcherLinks.transition(link.id, ["watching"], { status: "waking" }, at);
    const wake = store.watcherLinks.createWake({
      id: randomUUID(), linkId: link.id, watchedTurnId: null, trigger: "manual",
      eventsCovered: 0, itemsTruncated: 0, itemsOmitted: 0, digestBytes: 10,
    }, at)!;
    store.close();

    const second = await start(root, 1);
    const reconnected = await connectRuntime(second.websocketUrl);
    const snapshot = await welcome(reconnected);
    expect(snapshot.watchers).toMatchObject([{ id: link.id, status: "watching" }]);
    const feed = await request(reconnected, "watcher.feed.get", { linkId: link.id });
    expect(feed).toMatchObject({
      type: "request.result",
      result: { kind: "watcher.feed", linkId: link.id, items: [{ wakeId: wake.wakeId, state: "settled", outcome: "failed" }] },
    });
    expect(await request(reconnected, "watcher.attach", {
      linkId: randomUUID(), watchedConversationId: link.watcherConversationId,
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
      preset: "reviewer", instructions: "", sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS },
      privateConnect: "inherit", initialReview: false,
    })).toMatchObject({ type: "request.error", message: "A watcher can't watch another watcher." });
    reconnected.socket.close();
  });
});
