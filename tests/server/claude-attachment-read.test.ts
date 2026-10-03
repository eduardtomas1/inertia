// @inertia-test-suite portable
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { claudeSuccessResult, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const managers: ProviderManager[] = [];
const OWN = "11111111-1111-4111-8111-111111111111";
const SIBLING = "22222222-2222-4222-8222-222222222222";

function attachmentStore(root: string) {
  const store = join(realpathSync(root), "conversation-attachments");
  const own = join(store, OWN);
  const sibling = join(store, SIBLING);
  mkdirSync(own, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const ownFile = join(own, `${OWN}.log`);
  const siblingFile = join(sibling, `${SIBLING}.log`);
  writeFileSync(ownFile, "own chat");
  writeFileSync(siblingFile, "other chat");
  const link = join(own, "linked.log");
  if (process.platform !== "win32") symlinkSync(siblingFile, link);
  return { store, own, ownFile, siblingFile, link };
}

type ToolRequest = readonly [string, Record<string, unknown>, string | undefined];

async function runRequests(
  root: string,
  requests: readonly ToolRequest[],
  mode: { interactionMode: "build" | "plan"; access: "supervised" | "auto-edit" | "full" },
  attachmentReadRoots: readonly string[] | undefined,
  abortBefore?: number,
) {
  const results: PermissionResult[] = [];
  const harness = createClaudeAgentSdkHarness({
    createQuery: ({ options }) => {
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        const canUseTool = options?.canUseTool as CanUseTool;
        for (const [index, [toolName, input, blockedPath]] of requests.entries()) {
          const controller = new AbortController();
          if (index === abortBefore) controller.abort();
          results.push((await canUseTool(toolName, input, {
            signal: controller.signal,
            toolUseID: `tool-${index}`,
            requestId: `permission-${index}`,
            title: `Request ${index}`,
            ...(blockedPath === undefined ? {} : { blockedPath }),
          }))!);
        }
        yield claudeSuccessResult("Done", "completed");
      })();
      return fixtureClaudeQuery(stream);
    },
  });
  const manager = ProviderManager.createForTests(
    { commands: { claude: process.execPath } },
    new AgentHarnessRegistry([harness]),
  );
  managers.push(manager);
  const approvals: Array<{ title: string; access: string[] }> = [];
  await expect(manager.run(nativeProviderRunInput({
    providerId: "claude",
    conversationId: `claude-attachment-read-${mode.access}-${mode.interactionMode}`,
    cwd: root,
    prompt: "Read the attached log",
    ...mode,
    ...(attachmentReadRoots ? { attachmentReadRoots } : {}),
  }), {
    onApproval: (event) => {
      approvals.push({ title: event.request.title, access: event.request.permissionRoots.map(({ access }) => access) });
      manager.respondToApproval(event.conversationId, event.request.requestId, "deny", { runId: event.runId, turnId: event.turnId });
    },
  })).resolves.toMatchObject({ status: "completed" });
  return { results: results.map(({ behavior }) => behavior), approvals };
}

describe("Claude reads of this chat's own attachments", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(async (manager) => await manager.disposeAll()));
    await Promise.all(roots.splice(0).map(async (root) => await removePortableFixture(root)));
  });

  it.each([
    { interactionMode: "build" as const, access: "supervised" as const },
    { interactionMode: "build" as const, access: "auto-edit" as const },
    { interactionMode: "plan" as const, access: "supervised" as const },
    { interactionMode: "plan" as const, access: "full" as const },
  ])("allows only own attachment reads without an approval in $interactionMode / $access", async (mode) => {
    const root = portableFixtureRoot(`Claude attachment read ${mode.interactionMode} ${mode.access}`);
    roots.push(root);
    const files = attachmentStore(root);
    const requests: ToolRequest[] = [
      ["Read", { file_path: files.ownFile }, files.ownFile],
      ["Grep", { path: files.own, pattern: "ERROR" }, files.own],
      ["Read", { file_path: files.siblingFile }, files.siblingFile],
      ["Glob", { path: files.store, pattern: "*/*.log" }, files.store],
      ["Glob", { path: files.own, pattern: "../*/*.log" }, files.own],
      ["Write", { file_path: files.ownFile, content: "changed" }, files.ownFile],
      ["Read", { file_path: 42 }, undefined],
      ...(process.platform === "win32" ? [] : [["Read", { file_path: files.link }, files.link] as const]),
    ];
    const { results, approvals } = await runRequests(root, requests, mode, [files.own]);
    const asked = requests.slice(2).map(() => "deny");
    expect(results).toEqual(["allow", "allow", ...asked]);
    expect(approvals.map(({ title }) => title)).toEqual(requests.slice(2).map((_, index) => `Request ${index + 2}`));
    expect(approvals[0]!.access).toEqual(["read"]);
    expect(approvals[3]!.access).toEqual(["write"]);
  });

  it("still asks without a read grant and cancels an aborted own read", async () => {
    const root = portableFixtureRoot("Claude attachment read without grant");
    roots.push(root);
    const files = attachmentStore(root);
    const ungranted = await runRequests(root, [["Read", { file_path: files.ownFile }, files.ownFile]], {
      interactionMode: "build", access: "supervised",
    }, undefined);
    expect(ungranted).toEqual({ results: ["deny"], approvals: [{ title: "Request 0", access: ["read"] }] });
    const aborted = await runRequests(root, [["Read", { file_path: files.ownFile }, files.ownFile]], {
      interactionMode: "build", access: "supervised",
    }, [files.own], 0);
    expect(aborted).toEqual({ results: ["deny"], approvals: [] });
  });
});
