// @inertia-test-suite portable
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexControlClient, withCodexControlClient } from "../../src/server/codex/control-client";
import type { JsonObject } from "../../src/server/codex/protocol";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { createCodexNativeConversationOperations } from "../../src/server/provider/codex-native-conversation";
import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";
import type { NativeConversationLaunch, NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";

let root: string;
let launch: NativeConversationLaunch;
let request: NativeConversationRequest;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "inertia-native-control-")));
  launch = { executable: process.execPath, environment: {}, cwd: root };
  request = {
    operationId: "operation-1", kind: "fork", targetConversationId: "target-app-conversation",
    source: {
      identity: { projectId: "project", conversationId: "source-app-conversation", workspaceId: "workspace", repositoryId: "repository", providerInstanceId: "codex-instance" },
      nativeConversationId: "source-native-thread", nativeSessionId: "native-session-tree", expectedHeadId: "turn-3",
    },
    boundary: { kind: "turn", nativeTurnId: "turn-2" },
  };
});
afterEach(async () => await rm(root, { recursive: true, force: true }));

function fixture(options: { loaded?: boolean; historyMode?: string; mutateResponse?: (method: string, result: JsonObject) => JsonObject } = {}) {
  const sessions = new Map([ ["source-native-thread", ["turn-3", "turn-2", "turn-1"]] ]);
  let loaded = options.loaded ?? false;
  const metadata = (id: string): JsonObject => ({ thread: {
    id, sessionId: "native-session-tree", historyMode: options.historyMode ?? "paginated",
    status: { type: loaded ? "idle" : "notLoaded" },
  } });
  const rpc = vi.fn(async (method: string, params: JsonObject = {}): Promise<JsonObject> => {
    const id = String(params.threadId);
    let result: JsonObject;
    switch (method) {
      case "thread/read": result = metadata(id); break;
      case "thread/turns/list": result = { data: sessions.get(id)!.map((turn) => ({ id: turn, status: "completed" })), nextCursor: null }; break;
      case "thread/resume": loaded = true; result = metadata(id); break;
      case "thread/fork": {
        const turns = sessions.get(id)!;
        sessions.set("fork-native-thread", turns.slice(turns.indexOf(String(params.lastTurnId))));
        result = { thread: { ...metadata("fork-native-thread").thread as JsonObject, forkedFromId: id } };
        break;
      }
      case "thread/revert": {
        const turns = sessions.get(id)!;
        sessions.set(id, turns.slice(turns.indexOf(String(params.beforeTurnId)) + 1));
        result = metadata(id); break;
      }
      default: throw new Error(`Unexpected RPC ${method}`);
    }
    return options.mutateResponse?.(method, result) ?? result;
  });
  const control: typeof withCodexControlClient = async (_launch, run) => await run({ request: rpc });
  return { control, rpc, sessions };
}

describe("Codex native conversation control", () => {
  it("forks inclusively and preserves application, thread, and session-tree identities", async () => {
    const { control, rpc, sessions } = fixture();
    const harness = createCodexAppServerHarness({ withControlClient: control });
    const result = await harness.nativeConversation!.execute(request, launch);
    expect(result).toEqual({
      operationId: request.operationId, identity: request.source.identity, status: "completed", effect: "native-fork",
      targetConversationId: "target-app-conversation",
      backing: { nativeConversationId: "fork-native-thread", nativeSessionId: "native-session-tree", headId: "turn-2", persistedHeadId: "turn-2" },
    });
    expect(rpc).toHaveBeenCalledWith("thread/fork", expect.objectContaining({ threadId: "source-native-thread", lastTurnId: "turn-2", approvalPolicy: "never", sandbox: "read-only" }));
    expect(sessions.get("source-native-thread")).toEqual(["turn-3", "turn-2", "turn-1"]);
    expect(sessions.get("fork-native-thread")).toEqual(["turn-2", "turn-1"]);
  });

  it.each([false, true])("reverts the successor, loading only when required (loaded=%s)", async (loaded) => {
    const { control, rpc, sessions } = fixture({ loaded });
    const result = await createCodexNativeConversationOperations(new Set(), control).execute({ ...request, kind: "rollback" }, launch);
    expect(result).toMatchObject({ status: "completed", effect: "native-revert", backing: { headId: "turn-2" } });
    expect(rpc).toHaveBeenCalledWith("thread/revert", { threadId: "source-native-thread", beforeTurnId: "turn-3" });
    expect(rpc.mock.calls.some(([method]) => method === "thread/resume")).toBe(!loaded);
    expect(sessions.get("source-native-thread")).toEqual(["turn-2", "turn-1"]);
  });

  it.each([undefined, "turn-1"])("rolls back to thread start, retaining an inherited fork prefix %s", async (inheritedHeadId) => {
    const { control, sessions } = fixture();
    const result = await createCodexNativeConversationOperations(new Set(), control).execute({
      ...request, kind: "rollback", boundary: { kind: "start", ...(inheritedHeadId ? { inheritedHeadId } : {}) },
    }, launch);
    expect(result).toMatchObject({ status: "completed", backing: { headId: inheritedHeadId ?? null } });
    expect(sessions.get("source-native-thread")).toEqual(inheritedHeadId ? [inheritedHeadId] : []);
  });

  it("returns unchanged without mutation at the current head", async () => {
    const { control, rpc } = fixture();
    const result = await createCodexNativeConversationOperations(new Set(), control).execute({
      ...request, kind: "rollback", boundary: { kind: "turn", nativeTurnId: "turn-3" },
    }, launch);
    expect(result).toMatchObject({ status: "completed", effect: "unchanged" });
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/turns/list"]);
  });

  it.each(["legacy", "unknown"])("does not pretend unsupported %s history can revert", async (historyMode) => {
    const { control, rpc } = fixture({ historyMode });
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, launch))
      .toMatchObject({ status: "unsupported", reason: "paginated-native-history-required" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale head", (value: NativeConversationRequest) => { value.source.expectedHeadId = "stale"; }, "native-head-changed"],
    ["missing boundary", (value: NativeConversationRequest) => { value.boundary = { kind: "turn", nativeTurnId: "absent" }; }, "native-boundary-not-found"],
    ["wrong session", (value: NativeConversationRequest) => { value.source.nativeSessionId = "other-session"; }, "native-session-mismatch"],
  ] as const)("rejects %s before mutation", async (_name, mutate, reason) => {
    const { control, rpc } = fixture(); mutate(request);
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, launch)).toMatchObject({ status: "rejected", reason });
    expect(rpc.mock.calls.some(([method]) => ["thread/fork", "thread/revert"].includes(method))).toBe(false);
  });

  it.each([
    ["in-progress", { data: [{ id: "turn-3", status: "inProgress" }], nextCursor: null }, "rejected"],
    ["malformed", { data: [{ status: "completed" }], nextCursor: null }, "failed"],
    ["repeated cursor", { data: [{ id: "turn-3", status: "completed" }], nextCursor: "cursor" }, "failed"],
  ] as const)("fails closed on %s native history", async (_name, page, status) => {
    const { control, rpc } = fixture({ mutateResponse: (method, result) => method === "thread/turns/list" ? page : result });
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, launch)).toMatchObject({ status });
    expect(rpc.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
  });

  it("preserves the created ID and ambiguity when fork confirmation fails", async () => {
    const { control } = fixture({ mutateResponse: (method, result) => method === "thread/fork"
      ? { thread: { ...result.thread as JsonObject, sessionId: "wrong-root" } } : result });
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, launch)).toMatchObject({
      status: "failed", mutationMayHaveOccurred: true, createdNativeConversationId: "fork-native-thread",
    });
  });

  it("preserves a custom Codex route and excludes its credential from shell inheritance", async () => {
    const { rpc } = fixture();
    const calls: Array<{ method: string; params: JsonObject | undefined }> = [];
    const control: typeof withCodexControlClient = async (_options, run) => await run({ request: async (method, params) => {
      calls.push({ method, params });
      return method === "config/read" ? { config: { shell_environment_policy: { exclude: ["EXISTING_EXCLUDE"] } } }
        : await rpc(method, params);
    } });
    const result = await createCodexNativeConversationOperations(new Set(), control).execute(request, {
      ...launch, environment: { FIXTURE_BACKEND_CREDENTIAL: "fixture-placeholder" },
      harnessConfiguration: { kind: "codex-responses", providerId: "fixture_backend", displayName: "Fixture backend", baseUrl: "https://example.invalid/v1", credentialEnvironmentKey: "FIXTURE_BACKEND_CREDENTIAL" },
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(calls.find((call) => call.method === "thread/fork")?.params).toMatchObject({
      modelProvider: "fixture_backend", config: {
        "model_providers.fixture_backend": { env_key: "FIXTURE_BACKEND_CREDENTIAL", requires_openai_auth: false },
        "shell_environment_policy.exclude": ["EXISTING_EXCLUDE", "FIXTURE_BACKEND_CREDENTIAL"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-placeholder");
  });

  it("does not hide cleanup failure after a successful mutation", async () => {
    const { control } = fixture();
    const unclean: typeof control = async (options, run) => {
      await control(options, run);
      throw new ProcessTreeTerminationError("native operation");
    };
    expect(await createCodexNativeConversationOperations(new Set(), unclean).execute(request, launch)).toMatchObject({
      status: "failed", reason: "cleanup-unconfirmed", mutationMayHaveOccurred: true, createdNativeConversationId: "fork-native-thread",
    });
  });

  it("rejects active sources and handles pre-cancellation without opening a client", async () => {
    const invoked = vi.fn();
    const fixtureControl = fixture().control;
    const control: typeof withCodexControlClient = async (options, run) => { invoked(); return await fixtureControl(options, run); };
    const ops = createCodexNativeConversationOperations(new Set([request.source.nativeConversationId]), control);
    expect(await ops.execute(request, launch)).toMatchObject({ status: "rejected", reason: "conversation-busy" });
    const signal = AbortSignal.abort();
    expect(await ops.execute(request, { ...launch, signal })).toMatchObject({ status: "failed", reason: "cancelled", mutationMayHaveOccurred: false });
    expect(invoked).not.toHaveBeenCalled();
  });

  it("cancels during mutation and joins the control-client teardown", async () => {
    const abort = new AbortController();
    let cleaned = false;
    const { rpc } = fixture();
    const control: typeof withCodexControlClient = async (options, run) => {
      try {
        return await run({ request: async (method, params) => {
          if (method === "thread/fork") {
            abort.abort();
            options.signal!.throwIfAborted();
          }
          return await rpc(method, params);
        } });
      } finally { cleaned = true; }
    };
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, { ...launch, signal: abort.signal }))
      .toMatchObject({ status: "failed", reason: "cancelled", mutationMayHaveOccurred: true });
    expect(cleaned).toBe(true);
  });

  it("bounds a nonresponding native request with the abort signal", async () => {
    const control: typeof withCodexControlClient = async (options, run) => await run({
      request: async () => await new Promise<JsonObject>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      }),
    });
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, { ...launch, timeoutMs: 20 }))
      .toMatchObject({ status: "failed", reason: "deadline", mutationMayHaveOccurred: false });
  });

  it("paginates to an older stable boundary with bounded summary pages", async () => {
    const { rpc } = fixture();
    const paged: CodexControlClient = { request: async (method, params) => {
      if (method === "thread/turns/list" && params?.threadId === "source-native-thread") {
        return params.cursor ? { data: [{ id: "turn-2", status: "completed" }, { id: "turn-1", status: "completed" }], nextCursor: null }
          : { data: [{ id: "turn-3", status: "completed" }], nextCursor: "opaque-next" };
      }
      return await rpc(method, params);
    } };
    const control: typeof withCodexControlClient = async (_options, run) => await run(paged);
    expect(await createCodexNativeConversationOperations(new Set(), control).execute(request, launch))
      .toMatchObject({ status: "completed", backing: { headId: "turn-2" } });
  });
});
