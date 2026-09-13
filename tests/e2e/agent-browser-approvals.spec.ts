// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

test("binds inspectable browser approvals to the exact native document and hides password input", async () => {
  let conversationId = "";
  const app = await createAppFixture({
    name: "agent-browser-approvals", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try { conversationId = store.snapshot().conversations[0]!.id; } finally { store.close(); }
    },
  });
  try {
    await app.resizeWindow(1440, 920);
    const tools = await ensureWorkspaceTools(app.page);
    await selectWorkspaceTool(tools, "Browser");
    const evidence = await app.electronApp.evaluate(async ({ webContents }, request) => {
      type Command = import("../../src/shared/agent-browser-approval").AgentBrowserRequest;
      type Result = import("../../src/shared/agent-browser").AgentBrowserResult;
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (identity: { conversationId: string; runId: string; turnId: string }, command: Command) => Promise<Result>;
      };
      const identity = { conversationId: request.id, runId: "11111111-1111-4111-8111-111111111111",
        turnId: "22222222-2222-4222-8222-222222222222" };
      const perform = (command: Command) => runtime.agentBrowser(identity, command);
      const opened = await perform({ action: "navigate", url: request.url });
      if (!opened.ok) throw new Error(opened.message);
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === request.url);
      if (!contents) throw new Error("Missing native page");
      await contents.executeJavaScript('document.querySelector("input").removeAttribute("aria-label")');
      const snapshot = await perform({ action: "snapshot" });
      if (!snapshot.ok) throw new Error(snapshot.message);
      const { elements } = JSON.parse(snapshot.text) as { elements: Array<{ ref: string; name: string }> };
      const ref = elements.find(({ name }) => name === "Search destination")?.ref;
      if (!ref) throw new Error("Missing native text field");
      const command = { action: "type" as const, ref, text: "inspected delivery", replace: true };
      const prepare = async () => {
        const result = await perform({ action: "prepare-approval", command });
        if (!result.ok) throw new Error(result.message);
        return JSON.parse(result.text) as { token: string; detail: string };
      };
      const first = await prepare();
      const delivered = await perform({ action: "perform-approved", token: first.token });
      const text = await contents.executeJavaScript('document.querySelector("input").value') as string;
      const repeated = await perform({ action: "perform-approved", token: first.token });
      const stale = await prepare();
      await perform({ action: "navigate", url: request.url });
      const changedDocument = await perform({ action: "perform-approved", token: stale.token });
      await contents.executeJavaScript('document.querySelector("input").addEventListener("focus", (event) => event.target.setAttribute("aria-label", "Changed during focus"), { once: true })');
      const beforeFocus = await perform({ action: "snapshot" });
      if (!beforeFocus.ok) throw new Error(beforeFocus.message);
      command.ref = (JSON.parse(beforeFocus.text) as { elements: Array<{ ref: string; name: string }> })
        .elements.find(({ name }) => name === "Search destination")!.ref;
      const focusApproval = await prepare();
      const changedDuringFocus = await perform({ action: "perform-approved", token: focusApproval.token });
      const changedFieldText = await contents.executeJavaScript('document.querySelector("input").value') as string;
      await perform({ action: "navigate", url: request.url });
      const freshSnapshot = await perform({ action: "snapshot" });
      if (!freshSnapshot.ok) throw new Error(freshSnapshot.message);
      const fresh = JSON.parse(freshSnapshot.text) as { elements: Array<{ ref: string; name: string }> };
      command.ref = fresh.elements.find(({ name }) => name === "Search destination")!.ref;
      await contents.executeJavaScript('document.querySelector("input").addEventListener("focus", (event) => event.target.type = "password", { once: true })');
      const beforePassword = await prepare();
      const changedToPassword = await perform({ action: "perform-approved", token: beforePassword.token });
      const passwordText = await contents.executeJavaScript('document.querySelector("input").value') as string;
      await contents.executeJavaScript('document.querySelector("input").type = "password"');
      command.text = "unrecognizable private value";
      const sensitive = await prepare();
      await perform({ action: "discard-approval", token: sensitive.token });
      return { first, delivered, text, repeated, changedDocument, changedDuringFocus, changedFieldText,
        changedToPassword, passwordText, sensitive };
    }, { id: conversationId, url: `${app.previewUrl}agent-browser-destination` });
    expect(evidence.first.detail).toContain("Search destination");
    expect(evidence.first.detail).toContain("textbox");
    expect(evidence.first.detail).toContain("inspected delivery");
    expect(evidence.delivered.ok).toBe(true);
    expect(evidence.text).toBe("inspected delivery");
    expect(evidence.repeated.ok).toBe(false);
    expect(evidence.changedDocument.ok).toBe(false);
    expect(evidence.changedDuringFocus.ok).toBe(false);
    expect(evidence.changedFieldText).toBe("");
    expect(evidence.changedToPassword.ok).toBe(false);
    expect(evidence.passwordText).toBe("");
    expect(evidence.sensitive.detail).not.toContain("unrecognizable private value");
    expect(evidence.sensitive.detail).toContain("sensitive text hidden");
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
