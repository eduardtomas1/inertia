// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { capturePageWebSockets, publishCapturedWebSocketEvent } from "./support/browser-websocket-fixture";

const evidenceDirectory = process.env.INERTIA_BROWSER_TOOLS_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_BROWSER_TOOLS_EVIDENCE_DIR)
  : null;
const runId = "55555555-5555-4555-8555-555555555555";
const turnId = "66666666-6666-4666-8666-666666666666";
let app!: AppFixture;

test.skip(!evidenceDirectory, "Set INERTIA_BROWSER_TOOLS_EVIDENCE_DIR to capture Browser tool evidence.");
let conversationId = "";

async function preparedDetail(steps: unknown[], command: Record<string, unknown>, name = ""): Promise<string> {
  return await app.electronApp.evaluate(async (_electron, request) => {
    type Result = { ok: boolean; message?: string; text?: string };
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (identity: unknown, command: unknown) => Promise<Result>;
    };
    const identity = { conversationId: request.conversationId, runId: request.runId, turnId: request.turnId };
    let ref = "";
    for (const step of request.steps as Array<Record<string, unknown>>) {
      const result = await runtime.agentBrowser(identity, step);
      if (!result.ok) throw new Error(result.message);
      if (step.action === "snapshot") {
        const elements = (JSON.parse(result.text ?? "{}") as { elements: Array<{ ref: string; name: string }> }).elements;
        ref = elements.find(({ name }) => name === request.name)?.ref ?? "";
      }
    }
    const command = { ...request.command, ...(request.command.ref === "" ? { ref } : {}) };
    const prepared = await runtime.agentBrowser(identity, { action: "prepare-approval", command });
    if (!prepared.ok) throw new Error(prepared.message);
    const approval = JSON.parse(prepared.text ?? "{}") as { token: string; detail: string };
    await runtime.agentBrowser(identity, { action: "discard-approval", token: approval.token });
    return approval.detail;
  }, { conversationId, runId, turnId, steps, command, name });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-approval-evidence",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        conversationId = store.snapshot().conversations[0]!.id;
        const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6", alias: "GPT-5.6" });
        const requestedAt = new Date(Date.now() - 60_000).toISOString();
        store.beginAgentTurn({
          id: turnId, conversationId, runId, content: "Check the delete flow in the Browser.",
          providerId: "codex", modelSelection: selection, reasoningEffort: selection.reasoningEffort ?? "",
          interactionMode: "build", accessMode: "supervised",
          configurationRevision: selection.backendConfigurationRevision, association: "authoritative", requestedAt,
        });
        store.updateAgentTurnLifecycle(turnId, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
        store.updateAgentTurnLifecycle(turnId, { status: "waiting-for-approval", updatedAt: requestedAt });
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("captures the Browser approval cards for the new actions", async () => {
  await mkdir(evidenceDirectory!, { recursive: true });
  await app.resizeWindow(1440, 920);
  await capturePageWebSockets(app.page);
  await app.page.reload({ waitUntil: "domcontentloaded" });
  const cases = [
    {
      file: "approval-click-accept-dialog-light-wide.png",
      steps: [{ action: "navigate", url: `${app.previewUrl}agent-browser-confirm` }, { action: "snapshot" }],
      command: { action: "click", ref: "", dialog: "accept" },
      name: "Delete item",
      text: "and accept the page's confirmation dialog",
    },
    {
      file: "approval-history-reload-light-wide.png",
      steps: [{ action: "navigate", url: `${app.previewUrl}agent-browser-history-first` }, { action: "wait", state: "present", timeoutMs: 5_000 }, { action: "snapshot" }],
      command: { action: "history", direction: "reload" },
      text: "Reload http://127.0.0.1",
    },
    {
      file: "approval-scroll-to-ref-light-wide.png",
      steps: [{ action: "navigate", url: `${app.previewUrl}agent-browser-below-fold` }, { action: "snapshot" }],
      command: { action: "scroll", ref: "" },
      name: "Save at the bottom",
      text: "Scroll button: Save at the bottom into view",
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const detail = await preparedDetail(entry.steps, entry.command, "name" in entry ? entry.name : "");
    expect(detail).toContain(entry.text);
    await publishCapturedWebSocketEvent(app.page, {
      type: "agent.approval.requested",
      request: {
        id: `browser-evidence-approval-${index}`,
        providerId: "codex", conversationId, runId, turnId,
        kind: "permissions",
        title: "Control Inertia Browser",
        detail,
        reason: "This approval applies only to the inspected tab and document.",
        cwd: app.workspaceDirectory,
        command: null,
        networkScope: null,
        permissionRoots: [],
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
    const card = app.page.locator('[data-agent-request-state="approval"]').last();
    await expect(card).toContainText(entry.text);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ animations: "disabled", path: join(evidenceDirectory!, entry.file) });
    await publishCapturedWebSocketEvent(app.page, {
      type: "agent.approval.resolved", conversationId, runId, turnId,
      requestId: `browser-evidence-approval-${index}`, decision: "deny",
    });
  }
  expect(app.rendererErrors).toEqual([]);
});
