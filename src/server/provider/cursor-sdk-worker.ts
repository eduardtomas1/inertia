import { cursorSdkHostTools } from "./cursor-sdk-host-tools";
import { cursorSdkModelsSchema } from "../../node/cursor-sdk-models";
import { realpath, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolName } from "@cursor/sdk";
import { CursorSdkChannel } from "../../node/cursor-sdk-channel";
import { cursorSdkStartSchema } from "../../node/cursor-sdk-protocol";
import { CursorSdkSession } from "./cursor-sdk-session";
import { loadCursorSdk, verifyCursorSdkPlatform } from "./cursor-sdk-loader";
import { openCursorSdkStore } from "./cursor-sdk-store";

let session: CursorSdkSession | undefined;
let used = false;
const controller = new AbortController();
const channel = new CursorSdkChannel(process.stdin, process.stdout, handle, () => {
  controller.abort();
  process.exitCode = 1;
  process.stdin.destroy();
});

async function handle(method: string, params: unknown): Promise<unknown> {
  if (method === "hello") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (process.versions.electron || major !== 22 || minor! < 13) throw new Error("Unsupported Node runtime.");
    return { version: "1.0.38", node: process.versions.node };
  }
  if (method === "cancel") { controller.abort(); await session?.cancel(); return null; }
  if (method === "steer") {
    if (!session || typeof params !== "string") throw new Error("No active session.");
    return session.steer(params);
  }
  if (used || controller.signal.aborted) throw new Error("Worker already used.");
  used = true;
  if (method === "login") {
    const { Cursor } = loadCursorSdk();
    let urlDelivery: Promise<unknown> = Promise.resolve();
    const result = await Cursor.auth.login({ store: null, openBrowser: false, signal: controller.signal,
      onLoginUrl: (url) => {
        const parsed = new URL(url);
        if (parsed.origin !== "https://cursor.com" || url.length > 8192 || parsed.username || parsed.password) throw new Error("Invalid login URL.");
        urlDelivery = channel.request("login-url", url);
        void urlDelivery.catch(() => controller.abort());
      } });
    await urlDelivery;
    controller.signal.throwIfAborted();
    return { apiKey: result.apiKey, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs };
  }
  if (method === "models") {
    if (typeof params !== "string" || !params.trim() || params.length > 16384) throw new Error("Invalid private credential.");
    const models = await loadCursorSdk().Cursor.models.list({ apiKey: params });
    controller.signal.throwIfAborted();
    return cursorSdkModelsSchema.parse(models);
  }
  if (method === "inspect") {
    loadCursorSdk();
    verifyCursorSdkPlatform();
    const workspace = await realpath(process.cwd());
    const directory = await mkdtemp(join(workspace, ".cursor-sdk-probe-"));
    try {
      const store = await openCursorSdkStore(directory, workspace);
      await store.dispose();
      return { sdkVersion: "1.0.38", nativeStore: true, storeKind: "inertia-journal-v1" };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (method !== "start") throw new Error("Unknown operation.");
  const input = cursorSdkStartSchema.parse(params);
  if (await realpath(process.cwd()) !== input.authority.workspace) throw new Error("Worker workspace mismatch.");
  const sdk = loadCursorSdk();
  const store = await openCursorSdkStore(input.stateRoot, input.authority.workspace, input.apiKey);
  const native: ToolName[] = input.nativeTools === "none" ? [] : input.nativeTools === "read"
    ? ["read", "ls", "grep", "glob"] : ["read", "ls", "grep", "glob", "write", "edit", "shell"];
  try {
    session = new CursorSdkSession(input.authority, {
      store, create: (options) => sdk.Agent.create(options), resume: (id, options) => sdk.Agent.resume(id, options),
      assertAuthority: () => controller.signal.throwIfAborted(), model: input.model,
      tools: [...native, ...(input.tools.length ? ["mcp" as const] : [])],
      emit: async (message) => { await channel.request("event", { authority: input.authority, message }); },
      customTools: (sessionId) => cursorSdkHostTools(input, sessionId, controller.signal,
        (method, value, timeoutMs) => channel.request(method, value, timeoutMs)),
    });
    const result = await session.execute(input.apiKey, input.prompt, input.sessionId);
    return { ...result, agentId: session.nativeSessionId };
  } finally { await store.dispose?.(); }
}
