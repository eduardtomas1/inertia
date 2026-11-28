// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { getSessionMessages, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import type { ProviderFreshSessionPrior } from "../../src/server/provider/contracts";
import { createClaudeAgentSdkHarness, type ClaudeAgentSdkHarnessOptions } from "../../src/server/provider/claude-agent-sdk-harness";
import { readClaudePersistedNativeHead } from "../../src/server/provider/claude-native-conversation";
import { startHarnessWithFreshSessionFallback } from "../../src/server/provider/fresh-session-fallback";
import { claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

// A chat whose Claude session started in checkout A and that now runs in checkout B. Claude Code
// resumes `--resume <id>` from B and keeps appending to the transcript in A's project folder; this
// was observed with the bundled Claude Code 2.1.319 against a local fake Messages API (a worktree of
// A's repository and an unrelated folder). Claude Code 2.1.98 instead answers with only a result:
// a new random session id, no turns, and "No conversation found with session ID: <id>".

let root: string;
let original: string;
let moved: string;
let config: string;
let sessionId: string;
let transcript: string;
let ids: string[];

async function projectFolder(cwd: string): Promise<string> {
  let key = "";
  await getSessionMessages(randomUUID(), { dir: cwd, sessionStore: {
    append: async () => { throw new Error("Unexpected write"); },
    load: async (value) => { key = value.projectKey; return []; },
  } });
  return join(config, "projects", key);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "inertia-claude-moved-")));
  original = join(root, "checkout-a");
  moved = join(root, "checkout-b");
  config = join(root, "config");
  await mkdir(original);
  await mkdir(moved);
  sessionId = randomUUID();
  ids = Array.from({ length: 4 }, () => randomUUID());
  const folder = await projectFolder(original);
  await mkdir(folder, { recursive: true });
  await mkdir(await projectFolder(moved), { recursive: true });
  transcript = join(folder, `${sessionId}.jsonl`);
  // The last exchange already ran in B, as Claude Code records it after a resume there.
  await writeFile(transcript, ids.map((uuid, index) => JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant", uuid, sessionId, parentUuid: ids[index - 1] ?? null,
    isSidechain: false, cwd: index < 2 ? original : moved, version: "2.1.319",
    timestamp: new Date(Date.UTC(2026, 10, 18, 0, 0, index)).toISOString(),
    message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `message-${index}` }] },
  })).join("\n") + "\n");
});
afterEach(async () => await rm(root, { recursive: true, force: true }));

function start(createQuery: NonNullable<ClaudeAgentSdkHarnessOptions["createQuery"]>, events: AgentHarnessEvent[] = [],
  priors: ProviderFreshSessionPrior[] = [], environment: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: config }) {
  const harness = createClaudeAgentSdkHarness({ createQuery });
  return startHarnessWithFreshSessionFallback(harness, {
    input: nativeProviderRunInput({ providerId: "claude", conversationId: "moved-claude-chat", cwd: moved,
      prompt: "Continue in B", interactionMode: "build", access: "supervised", sessionId }),
    executable: process.execPath, environment, providerNativeToolsAvailable: false,
    callbacks: { onEvent: (event) => { events.push(event); } },
  }, (prior) => { priors.push(prior); return { prompt: "Continue in B, with the restored history." }; });
}

describe("a Claude session resumed in a moved checkout", () => {
  it("resumes the original session in the new checkout and reads its settled head from the original folder", async () => {
    const launches: Options[] = [];
    const events: AgentHarnessEvent[] = [];
    const run = start(({ options }) => {
      launches.push(options!);
      return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield { ...claudeSystem("init"), session_id: sessionId };
        yield { ...claudeSuccessResult("Continued in B"), session_id: sessionId };
      })());
    }, events);
    await expect(run.result).resolves.toMatchObject({ status: "completed", sessionId, text: "Continued in B" });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ cwd: moved, resume: sessionId });
    expect(launches[0]!.sessionId).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: "native-boundary", phase: "settled",
      nativeConversationId: sessionId, persistedHeadId: ids[3] }));
    expect((await readFile(transcript, "utf8")).split("\n").filter(Boolean)).toHaveLength(4);
  });

  const refusingOldClaudeCode = (launches: Options[]): NonNullable<ClaudeAgentSdkHarnessOptions["createQuery"]> => ({ options }) => {
    launches.push(options!);
    const resumed = options?.resume !== undefined;
    return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
      if (resumed) {
        yield { ...claudeSuccessResult(""), subtype: "error_during_execution", session_id: randomUUID(), is_error: true,
          num_turns: 0, duration_ms: 0, duration_api_ms: 0, result: undefined,
          errors: [`No conversation found with session ID: ${sessionId}`] } as unknown as SDKMessage;
        return;
      }
      yield claudeSystem("init");
      yield claudeSuccessResult("Answered from a fresh session in B");
    })());
  };

  it("starts fresh in the new checkout when an older Claude Code cannot find the session from there", async () => {
    const launches: Options[] = [];
    const priors: ProviderFreshSessionPrior[] = [];
    const run = start(refusingOldClaudeCode(launches), [], priors);
    await expect(run.result).resolves.toMatchObject({ status: "completed", text: "Answered from a fresh session in B" });
    expect(launches).toHaveLength(2);
    expect(launches[0]).toMatchObject({ cwd: moved, resume: sessionId });
    expect(launches[1]).toMatchObject({ cwd: moved });
    expect(launches[1]!.resume).toBeUndefined();
    // The transcript is still in A's project folder: only this Claude Code could not reach it from B.
    expect(priors).toEqual([{ priorCleanup: "confirmed", sessionStoredElsewhere: true }]);
  });

  it("does not claim a stored session when the transcript is gone from the Claude home", async () => {
    await rm(transcript);
    const priors: ProviderFreshSessionPrior[] = [];
    await expect(start(refusingOldClaudeCode([]), [], priors).result).resolves.toMatchObject({ status: "completed" });
    expect(priors).toEqual([{ priorCleanup: "confirmed" }]);
  });

  it("does not claim a stored session when a current Claude Code deliberately refused the resume", async () => {
    // worktree_resume_refused: the session's worktree failed Claude Code's checks. Its transcript is elsewhere by
    // construction, which proves nothing about Claude Code being unable to find it.
    const priors: ProviderFreshSessionPrior[] = [];
    const refusing: NonNullable<ClaudeAgentSdkHarnessOptions["createQuery"]> = ({ options }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
      if (options?.resume !== undefined) {
        yield { ...claudeSuccessResult(""), subtype: "error_during_execution", session_id: sessionId, is_error: true,
          num_turns: 0, result: undefined, startup_failure_reason: "worktree_resume_refused",
          errors: ["Refusing to resume this session in its worktree."] } as unknown as SDKMessage;
        return;
      }
      yield claudeSystem("init");
      yield claudeSuccessResult("Fresh");
    })());
    await expect(start(refusing, [], priors).result).resolves.toMatchObject({ status: "completed" });
    expect(priors).toEqual([{ priorCleanup: "confirmed" }]);
  });

  it("does not claim a stored session when Claude Code resolves a relative configuration folder itself", async () => {
    // Inertia would read HOME/.claude, which holds the transcript here, while Claude Code searched another home.
    const home = join(root, "home");
    const fallbackFolder = join(home, ".claude", "projects", basename(dirname(transcript)));
    await mkdir(fallbackFolder, { recursive: true });
    await copyFile(transcript, join(fallbackFolder, basename(transcript)));
    const priors: ProviderFreshSessionPrior[] = [];
    await expect(start(refusingOldClaudeCode([]), [], priors, { HOME: home, CLAUDE_CONFIG_DIR: "relative-config" }).result)
      .resolves.toMatchObject({ status: "completed" });
    expect(priors).toEqual([{ priorCleanup: "confirmed" }]);
  });

  it("searches the whole home again for the evidence, noticing a copy made after the folder was remembered", async () => {
    expect(await readClaudePersistedNativeHead(sessionId, moved, { CLAUDE_CONFIG_DIR: config })).toBe(ids[3]);
    const copy = join(config, "projects", "-copied-project");
    await mkdir(copy);
    await copyFile(transcript, join(copy, basename(transcript)));
    const priors: ProviderFreshSessionPrior[] = [];
    await expect(start(refusingOldClaudeCode([]), [], priors).result).resolves.toMatchObject({ status: "completed" });
    expect(priors).toEqual([{ priorCleanup: "confirmed" }]);
  });
});
