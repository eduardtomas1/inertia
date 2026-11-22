// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeNativeContinuationOptions, createClaudeNativeConversationOperations, readClaudePersistedNativeHead } from "../../src/server/provider/claude-native-conversation";
import type { NativeConversationLaunch, NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { nativeProviderRunInput } from "./model-route-fixture";
import { claudeSuccessResult, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";

let root: string;
let directory: string;
let transcript: string;
let sourceText: string;
let sourceId: string;
let ids: string[];
let launch: NativeConversationLaunch;
let request: NativeConversationRequest;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "inertia-claude-native-")));
  const cwd = join(root, "workspace");
  const config = join(root, "config");
  await mkdir(cwd);
  sourceId = randomUUID(); ids = Array.from({ length: 4 }, () => randomUUID());
  let key = "";
  await getSessionMessages(sourceId, { dir: cwd, sessionStore: {
    append: async () => { throw new Error("Unexpected write"); },
    load: async (value) => { key = value.projectKey; return []; },
  } });
  directory = join(config, "projects", key);
  await mkdir(directory, { recursive: true });
  transcript = join(directory, `${sourceId}.jsonl`);
  sourceText = ids.map((uuid, index) => JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant", uuid, sessionId: sourceId,
    parentUuid: ids[index - 1] ?? null, isSidechain: false, cwd,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), version: "2.1.0",
    message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `message-${index}` }] },
  })).join("\n") + "\n";
  await writeFile(transcript, sourceText);
  launch = { executable: process.execPath, cwd, environment: { CLAUDE_CONFIG_DIR: config } };
  request = {
    kind: "fork", operationId: randomUUID(), targetConversationId: randomUUID(),
    source: {
      identity: { projectId: "project", conversationId: "application-conversation", workspaceId: "workspace", repositoryId: null, providerInstanceId: "claude-account-1" },
      nativeConversationId: sourceId, expectedHeadId: ids[3],
    },
    boundary: { kind: "turn", nativeTurnId: ids[1]! },
  };
});
afterEach(async () => await rm(root, { recursive: true, force: true }));

describe("Claude native conversation control", () => {
  it("takes a settled native boundary only from the scoped persisted transcript", async () => {
    expect(await readClaudePersistedNativeHead(sourceId, launch.cwd, launch.environment)).toBe(ids[3]);
    expect(await readClaudePersistedNativeHead(randomUUID(), launch.cwd, launch.environment)).toBeNull();
    await writeFile(transcript, sourceText.replace(sourceId, randomUUID()));
    expect(await readClaudePersistedNativeHead(sourceId, launch.cwd, launch.environment)).toBeNull();
  });
  it("uses the installed SDK to fork an inclusive prefix and reports the remapped head", async () => {
    const result = await createClaudeNativeConversationOperations(new Set()).execute(request, launch);
    expect(result).toMatchObject({ status: "completed", effect: "native-fork", identity: request.source.identity, operationId: request.operationId });
    if (result.status !== "completed") throw new Error(JSON.stringify(result));
    const nativeId = result.backing.nativeConversationId;
    expect(nativeId).not.toBe(sourceId);
    const forkText = await readFile(join(directory, `${nativeId}.jsonl`), "utf8");
    const records = forkText.trim().split("\n").map((line) => JSON.parse(line));
    const messages = records.filter((record) => ["user", "assistant"].includes(record.type));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.message.content[0].text)).toEqual(["message-0", "message-1"]);
    expect(messages.every((message) => message.sessionId === nativeId && !ids.includes(message.uuid))).toBe(true);
    expect(messages[0].parentUuid).toBeNull();
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
    expect(result.backing.headId).toBe(messages[1].uuid);
    expect(messages[1].forkedFrom).toEqual({ sessionId: sourceId, messageUuid: ids[1] });
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
  });

  it("rolls back using an exact deferred resume cursor without rewriting the source", async () => {
    const result = await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback" }, launch);
    expect(result).toMatchObject({ status: "completed", effect: "resume-cursor", backing: {
      nativeConversationId: sourceId, headId: ids[1], persistedHeadId: ids[3],
      continuation: { kind: "resume-cursor", nativeConversationId: sourceId, resumeSessionAt: ids[1] },
    } });
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
    expect(await readdir(directory)).toEqual([`${sourceId}.jsonl`]);
  });

  it("allocates a fresh native session at the unbranched thread start", async () => {
    const result = await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback", boundary: { kind: "start" } }, launch);
    expect(result).toMatchObject({ status: "completed", effect: "new-session", backing: { headId: null, continuation: { kind: "new-session" } } });
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.backing.nativeConversationId).not.toBe(sourceId);
    expect(result.backing.continuation?.nativeConversationId).toBe(result.backing.nativeConversationId);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("retains the inherited prefix when reverting a fork to its application start", async () => {
    expect(await createClaudeNativeConversationOperations(new Set()).execute({
      ...request, kind: "rollback", boundary: { kind: "start", inheritedHeadId: ids[1] },
    }, launch)).toMatchObject({ status: "completed", effect: "resume-cursor", backing: { headId: ids[1] } });
  });

  it("does not mutate when already at the selected head", async () => {
    expect(await createClaudeNativeConversationOperations(new Set()).execute({
      ...request, kind: "rollback", boundary: { kind: "turn", nativeTurnId: ids[3]! },
    }, launch)).toMatchObject({ status: "completed", effect: "unchanged" });
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
  });

  it.each(["head", "boundary", "session"])("rejects a stale or foreign %s before mutation", async (kind) => {
    if (kind === "head") request.source.expectedHeadId = randomUUID();
    if (kind === "boundary") request.boundary = { kind: "turn", nativeTurnId: randomUUID() };
    if (kind === "session") request.source.nativeSessionId = randomUUID();
    expect(await createClaudeNativeConversationOperations(new Set()).execute(request, launch)).toMatchObject({ status: "rejected" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it.each(["malformed", "wrong-session", "oversized", "invalid-utf8"])("fails closed for a %s transcript", async (kind) => {
    if (kind === "malformed") await writeFile(transcript, "not-json\n");
    if (kind === "wrong-session") await writeFile(transcript, sourceText.replaceAll(sourceId, randomUUID()));
    if (kind === "oversized") await truncate(transcript, 16 * 1024 * 1024 + 1);
    if (kind === "invalid-utf8") await writeFile(transcript, Buffer.from([0xff]));
    expect((await createClaudeNativeConversationOperations(new Set()).execute(request, launch)).status).not.toBe("completed");
    expect(await readdir(directory)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("rejects a transcript symlink without reading or mutating its target", async () => {
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, sourceText);
    await rm(transcript);
    await symlink(outside, transcript);
    expect(await createClaudeNativeConversationOperations(new Set()).execute(request, launch)).toMatchObject({ status: "rejected", reason: "native-transcript-unavailable" });
    expect(await readFile(outside, "utf8")).toBe(sourceText);
  });

  it("does not search a different config home or project scope", async () => {
    const other = join(root, "other-config"); await mkdir(other);
    expect(await createClaudeNativeConversationOperations(new Set()).execute(request, { ...launch, environment: { CLAUDE_CONFIG_DIR: other } }))
      .toMatchObject({ status: "rejected", reason: "native-transcript-unavailable" });
    expect(await createClaudeNativeConversationOperations(new Set()).execute(request, { ...launch, environment: { ...launch.environment, CLAUDE_CODE_PROJECT_DIR_NAME: "foreign-project" } }))
      .toMatchObject({ status: "rejected", reason: "native-transcript-scope-mismatch" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("rejects a transcript modified while the bounded snapshot is being read", async () => {
    let changed = false;
    const ops = createClaudeNativeConversationOperations(new Set(), { afterOperation: async (operation) => {
      if (operation === "read" && !changed) { changed = true; await writeFile(transcript, sourceText + "\n"); }
    } });
    expect(await ops.execute(request, launch)).toMatchObject({ status: "rejected", reason: "native-history-changed-during-read" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("blocks active sources and pre-cancelled requests", async () => {
    const ops = createClaudeNativeConversationOperations(new Set([sourceId]));
    expect(await ops.execute(request, launch)).toMatchObject({ status: "rejected", reason: "conversation-busy" });
    expect(await ops.execute(request, { ...launch, signal: AbortSignal.abort() })).toMatchObject({ status: "failed", reason: "cancelled", mutationMayHaveOccurred: false });
    expect(await readdir(directory)).toHaveLength(1);
  });

  describe("while a later source turn runs", () => {
    /** The running turn's entries after the settled head (ids[3]); `parent` overrides where its chain attaches. */
    function liveEntries(parent: string = ids[3]!) {
      const running = [randomUUID(), randomUUID()];
      const text = running.map((uuid, index) => JSON.stringify({
        type: index === 0 ? "user" : "assistant", uuid, sessionId: sourceId,
        parentUuid: index === 0 ? parent : running[0], isSidechain: false, cwd: launch.cwd,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(), version: "2.1.0",
        message: { role: index === 0 ? "user" : "assistant", content: [{ type: "text", text: `running-${index}` }] },
      })).join("\n") + "\n";
      return { running, text };
    }
    const live = () => ({ ...request, source: { ...request.source, live: true as const } });

    it("forks the completed boundary natively, leaving out the running turn and its partly written entry", async () => {
      const { text } = liveEntries();
      // The running Claude is mid-append: its last entry has no line end yet.
      const liveText = sourceText + text + '{"type":"assistant","uuid":"';
      await writeFile(transcript, liveText);
      const active = new Set([sourceId]);
      // The same snapshot without the live flag is a changed head (and the torn line is malformed): never native.
      expect((await createClaudeNativeConversationOperations(active).execute(request, launch)).status).toBe("rejected");
      const result = await createClaudeNativeConversationOperations(active).execute(live(), launch);
      if (result.status !== "completed") throw new Error(JSON.stringify(result));
      expect(result.effect).toBe("native-fork");
      const forkText = await readFile(join(directory, `${result.backing.nativeConversationId}.jsonl`), "utf8");
      const messages = forkText.trim().split("\n").map((line) => JSON.parse(line))
        .filter((record) => ["user", "assistant"].includes(record.type));
      expect(messages.map((message) => message.message.content[0].text)).toEqual(["message-0", "message-1"]);
      expect(result.backing.headId).toBe(messages[1].uuid);
      expect(await readFile(transcript, "utf8")).toBe(liveText);
    });

    it.each([
      // The live chain no longer runs through the settled head: a later write replaced history Inertia recorded.
      { write: "a branch from before the settled head", parent: () => ids[1]!, boundary: () => ids[1]!, reason: "native-head-changed" },
      // The boundary is a message the running turn wrote after the settled head.
      { write: "the boundary after the settled head", parent: () => ids[3]!, boundary: (running: string[]) => running[1]!, reason: "native-boundary-not-found" },
    ])("rejects $write before mutation", async ({ parent, boundary, reason }) => {
      const { running, text } = liveEntries(parent());
      await writeFile(transcript, sourceText + text);
      const result = await createClaudeNativeConversationOperations(new Set([sourceId])).execute(
        { ...live(), boundary: { kind: "turn", nativeTurnId: boundary(running) } }, launch);
      expect(result).toMatchObject({ status: "rejected", reason });
      expect(await readdir(directory)).toEqual([`${sourceId}.jsonl`]);
    });

    it("accepts the live flag on a fork only", async () => {
      expect(await createClaudeNativeConversationOperations(new Set()).execute({ ...live(), kind: "rollback" }, launch))
        .toMatchObject({ status: "rejected", reason: "invalid-request" });
      expect(await readdir(directory)).toEqual([`${sourceId}.jsonl`]);
    });
  });

  it("keeps the source locked until abandoned filesystem work settles, with no late fork", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const ops = createClaudeNativeConversationOperations(new Set(), {
      afterOperation: async (operation) => { if (operation === "read") { entered(); await gate; } },
    });
    const abort = new AbortController();
    const running = ops.execute(request, { ...launch, signal: abort.signal });
    await started;
    abort.abort();
    expect(await running).toMatchObject({ status: "failed", reason: "cancelled", mutationMayHaveOccurred: false });
    expect(await ops.execute(request, launch)).toMatchObject({ status: "rejected", reason: "conversation-busy" });
    release();
    // The retained operation unwinds its handle and lock before admission.
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback" }, launch);
      if (result.status === "completed") break;
    }
    expect(result).toMatchObject({ status: "completed", effect: "resume-cursor" });
    expect(await readdir(directory)).toEqual([`${sourceId}.jsonl`]);
  });
});

/** The project folder Claude Code names after a cwd, as the installed SDK derives it. */
async function projectFolder(cwd: string): Promise<string> {
  let key = "";
  await getSessionMessages(randomUUID(), { dir: cwd, sessionStore: {
    append: async () => { throw new Error("Unexpected write"); },
    load: async (value) => { key = value.projectKey; return []; },
  } });
  return join(root, "config", "projects", key);
}

describe("a transcript after the chat moved to another checkout", () => {
  // Resumed from another cwd, Claude Code keeps appending to the transcript in the folder of the cwd the
  // session started in (verified with the bundled Claude Code 2.1.319, see session-cwd-mobility.ts).
  let moved: NativeConversationLaunch;
  let movedFolder: string;
  beforeEach(async () => {
    const cwd = join(root, "moved-checkout");
    await mkdir(cwd);
    movedFolder = await projectFolder(cwd);
    await mkdir(movedFolder, { recursive: true });
    moved = { ...launch, cwd };
  });

  it("reads the settled head from the session's original project folder", async () => {
    expect(await readClaudePersistedNativeHead(sourceId, moved.cwd, moved.environment)).toBe(ids[3]);
  });

  it("rolls back natively without touching the original transcript", async () => {
    expect(await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback" }, moved))
      .toMatchObject({ status: "completed", effect: "resume-cursor", backing: { nativeConversationId: sourceId, headId: ids[1] } });
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
    expect(await readdir(movedFolder)).toEqual([]);
  });

  it("forks into the moved checkout's project folder, where any Claude Code resumes it", async () => {
    const result = await createClaudeNativeConversationOperations(new Set()).execute(request, moved);
    if (result.status !== "completed") throw new Error(JSON.stringify(result));
    expect(await readdir(movedFolder)).toEqual([`${result.backing.nativeConversationId}.jsonl`]);
    expect(await readdir(directory)).toEqual([`${sourceId}.jsonl`]);
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
  });

  it("creates the project folder of a checkout Claude Code never ran in for a fork", async () => {
    const cwd = join(root, "new-worktree");
    await mkdir(cwd);
    const folder = await projectFolder(cwd);
    const result = await createClaudeNativeConversationOperations(new Set()).execute(request, { ...launch, cwd });
    if (result.status !== "completed") throw new Error(JSON.stringify(result));
    expect(await readdir(folder)).toEqual([`${result.backing.nativeConversationId}.jsonl`]);
    if (process.platform !== "win32") expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readFile(transcript, "utf8")).toBe(sourceText);
  });

  it("remembers the folder that holds a moved session instead of rescanning the home on every read", async () => {
    for (let index = 0; index < 5; index += 1) await mkdir(join(root, "config", "projects", `-other-project-${index}`));
    const probes = async () => {
      const paths: string[] = [];
      const ops = createClaudeNativeConversationOperations(new Set(), {
        beforeOperation: (operation, path) => { if (operation === "lstat" && path.endsWith(`${sourceId}.jsonl`)) paths.push(path); },
      });
      expect(await ops.execute({ ...request, kind: "rollback" }, moved)).toMatchObject({ status: "completed" });
      return [...new Set(paths)];
    };
    expect((await probes()).length).toBeGreaterThan(5);
    expect(await probes()).toEqual([join(movedFolder, `${sourceId}.jsonl`), transcript]);
    // A transcript Claude Code moved on is found again by a full search.
    const elsewhere = join(root, "config", "projects", "-other-project-3");
    await rename(transcript, join(elsewhere, `${sourceId}.jsonl`));
    expect((await probes()).length).toBeGreaterThan(5);
    expect(await readClaudePersistedNativeHead(sourceId, moved.cwd, moved.environment)).toBe(ids[3]);
  });

  it("refuses a session held by more than one other project folder", async () => {
    const copy = join(root, "config", "projects", "-copied-project");
    await mkdir(copy);
    await writeFile(join(copy, `${sourceId}.jsonl`), sourceText);
    expect(await readClaudePersistedNativeHead(sourceId, moved.cwd, moved.environment)).toBeNull();
    expect(await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback" }, moved))
      .toMatchObject({ status: "rejected", reason: "native-transcript-unavailable" });
    // The cwd's own folder still wins, as in Claude Code's own resume.
    expect(await readClaudePersistedNativeHead(sourceId, launch.cwd, launch.environment)).toBe(ids[3]);
  });

  it.skipIf(process.platform === "win32")("ignores a project folder reached through a symlink", async () => {
    const outside = join(root, "outside-project");
    await mkdir(outside);
    await writeFile(join(outside, `${sourceId}.jsonl`), sourceText);
    await rm(transcript);
    await symlink(outside, join(root, "config", "projects", "-linked-project"));
    expect(await readClaudePersistedNativeHead(sourceId, moved.cwd, moved.environment)).toBeNull();
    expect(await createClaudeNativeConversationOperations(new Set()).execute({ ...request, kind: "rollback" }, moved))
      .toMatchObject({ status: "rejected", reason: "native-transcript-unavailable" });
  });

  it("keeps a configured project folder name exact", async () => {
    const environment = { ...launch.environment, CLAUDE_CODE_PROJECT_DIR_NAME: "-configured-project" };
    await mkdir(join(root, "config", "projects", "-configured-project"));
    expect(await readClaudePersistedNativeHead(sourceId, moved.cwd, environment)).toBeNull();
  });
});

describe("Claude continuation launch options", () => {
  it("supplies native resumeSessionAt only with the matching selected session", () => {
    expect(claudeNativeContinuationOptions(sourceId, { kind: "resume-cursor", nativeConversationId: sourceId, resumeSessionAt: ids[1]! }))
      .toEqual({ resume: sourceId, resumeSessionAt: ids[1] });
    expect(() => claudeNativeContinuationOptions(randomUUID(), { kind: "resume-cursor", nativeConversationId: sourceId, resumeSessionAt: ids[1]! })).toThrow("does not match");
    expect(() => claudeNativeContinuationOptions(undefined, { kind: "resume-cursor", nativeConversationId: sourceId, resumeSessionAt: ids[1]! })).toThrow("invalid");
  });
  it("starts the allocated session without trying to resume a nonexistent transcript", () => {
    expect(claudeNativeContinuationOptions(sourceId, { kind: "new-session", nativeConversationId: sourceId })).toEqual({ sessionId: sourceId });
    expect(claudeNativeContinuationOptions(sourceId, undefined)).toEqual({ resume: sourceId });
  });

  it.each(["resume-cursor", "new-session"] as const)("wires %s through the real harness and excludes concurrent native control", async (kind) => {
    let queryOptions: Options | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const harness = createClaudeAgentSdkHarness({ createQuery: ({ options }) => {
      queryOptions = options; ready();
      return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        await gate;
        yield { ...claudeSuccessResult("done"), session_id: sourceId };
      })());
    } });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude", conversationId: request.source.identity.conversationId, cwd: launch.cwd,
        prompt: "Continue from this boundary", interactionMode: "build", access: "supervised", sessionId: sourceId,
      }),
      nativeContinuation: kind === "new-session" ? { kind, nativeConversationId: sourceId }
        : { kind, nativeConversationId: sourceId, resumeSessionAt: ids[1]! },
      executable: launch.executable, environment: launch.environment, providerNativeToolsAvailable: false,
    });
    await started;
    expect(await harness.nativeConversation!.execute(request, launch)).toMatchObject({ status: "rejected", reason: "conversation-busy" });
    if (kind === "resume-cursor") {
      expect(queryOptions).toMatchObject({ resume: sourceId, resumeSessionAt: ids[1] });
      expect(queryOptions?.sessionId).toBeUndefined();
    } else {
      expect(queryOptions?.sessionId).toBe(sourceId);
      expect(queryOptions?.resume).toBeUndefined();
    }
    release();
    expect(await run.result).toMatchObject({ status: "completed", sessionId: sourceId });
    expect(await harness.nativeConversation!.execute({ ...request, kind: "rollback" }, launch)).toMatchObject({ status: "completed", effect: "resume-cursor" });
  });

  it("rejects a mismatched continuation before constructing the SDK query", async () => {
    let queried = false;
    const harness = createClaudeAgentSdkHarness({ createQuery: () => { queried = true; throw new Error("must not launch"); } });
    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude", conversationId: "conversation", cwd: launch.cwd,
        prompt: "Continue", interactionMode: "build", access: "supervised", sessionId: sourceId,
      }),
      nativeContinuation: { kind: "resume-cursor", nativeConversationId: randomUUID(), resumeSessionAt: ids[1]! },
      executable: launch.executable, environment: launch.environment, providerNativeToolsAvailable: false,
    });
    expect(await run.result).toMatchObject({ status: "failed" });
    expect(queried).toBe(false);
  });
});
