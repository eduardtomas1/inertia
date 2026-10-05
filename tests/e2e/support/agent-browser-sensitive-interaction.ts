import { expect } from "@playwright/test";
import type { AgentBrowserCommand } from "../../../src/shared/agent-browser";
import type { AppFixture } from "./app-fixture";

export async function expectSensitiveFieldInteraction(app: AppFixture, conversationId: string): Promise<void> {
  const url = `${app.previewUrl}agent-browser-react-login`;
  const perform = async (command: AgentBrowserCommand) => await app.electronApp.evaluate(
    async (_electron, request) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: AgentBrowserCommand) => Promise<{ ok: boolean; text?: string; code?: string }>;
      };
      return await runtime.agentBrowser(request.id, request.command);
    }, { id: conversationId, command },
  );
  const snapshot = async () => {
    const result = await perform({ action: "snapshot" });
    expect(result).toMatchObject({ ok: true });
    for (const value of ["manually-prefilled-sentinel", "replacement-password-sentinel", "943821"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
    return JSON.parse(result.text!) as { text: string; elements: Array<{ name: string; value?: string; ref: string }> };
  };
  const ref = (page: Awaited<ReturnType<typeof snapshot>>, name: string) => {
    const element = page.elements.find((entry) => entry.name === name);
    expect(element, name).toBeDefined();
    return element!.ref;
  };
  expect(await perform({ action: "navigate", url })).toMatchObject({ ok: true });
  expect(await perform({ action: "wait", text: "Sign in", state: "present", timeoutMs: 5_000 })).toMatchObject({ ok: true });
  const empty = await snapshot();
  ref(empty, "Password");
  ref(empty, "Backup password");
  // Native input emulates a person prefilling the existing controlled field.
  await app.electronApp.evaluate(async ({ webContents }, pageUrl) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === pageUrl)!;
    await contents.executeJavaScript("document.querySelector('#password').focus()", true);
    await contents.insertText("manually-prefilled-sentinel");
  }, url);
  const filled = await snapshot();
  expect(filled.elements).toContainEqual(expect.objectContaining({ name: "Password", value: "[redacted]" }));
  expect(await perform({ action: "type", ref: ref(filled, "Password"), text: "replacement-password-sentinel", replace: true }))
    .toMatchObject({ ok: true });
  const replaced = await snapshot();
  expect(await app.electronApp.evaluate(async ({ webContents }, pageUrl) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === pageUrl)!;
    return await contents.executeJavaScript("document.querySelector('#password').value === 'replacement-password-sentinel'");
  }, url)).toBe(true);
  expect(await perform({ action: "click", ref: ref(replaced, "Sign in") })).toMatchObject({ ok: true });
  const mfa = await snapshot();
  expect(mfa.text).toContain("Verify your identity");
  expect(await perform({ action: "type", ref: ref(mfa, "Authentication code"), text: "943821", replace: true }))
    .toMatchObject({ ok: true });
  const coded = await snapshot();
  expect(coded.elements).toContainEqual(expect.objectContaining({ name: "Authentication code", value: "[redacted]" }));
  expect(await perform({ action: "click", ref: ref(coded, "Verify") })).toMatchObject({ ok: true });
  const done = await snapshot();
  expect(done.text).toContain("Welcome back");
  ref(done, "Open [redacted]");
  expect(await perform({ action: "screenshot" })).toMatchObject({ ok: false, code: "sensitive" });
}
