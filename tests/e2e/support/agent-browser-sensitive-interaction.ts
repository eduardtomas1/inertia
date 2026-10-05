import { expect, type Locator } from "@playwright/test";
import type { AgentBrowserCommand } from "../../../src/shared/agent-browser";
import type { AppFixture } from "./app-fixture";

const SENTINELS = ["admin-typed-sentinel", "replacement-password-sentinel", "943821"];

export async function expectSensitiveFieldInteraction(
  app: AppFixture,
  conversationId: string,
  preview: Locator,
): Promise<void> {
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
    for (const value of SENTINELS) expect(JSON.stringify(result)).not.toContain(value);
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
  ref(empty, "Backup password");
  expect(await perform({ action: "type", ref: ref(empty, "Username"), text: "admin", replace: true }))
    .toMatchObject({ ok: true });
  ref(empty, "Password");
  await app.electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === request.url)!;
    await contents.executeJavaScript("document.querySelector('#password').focus()", true);
    for (const character of request.text) await contents.insertText(character);
  }, { url, text: "admin-typed-sentinel" });
  const filled = await snapshot();
  expect(filled.text).toContain("Sign in");
  expect(filled.elements).toContainEqual(expect.objectContaining({ name: "Username", value: "admin" }));
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
  expect(mfa.text).toContain("Signed in as admin");
  expect(await perform({ action: "type", ref: ref(mfa, "Authentication code"), text: "943821", replace: true }))
    .toMatchObject({ ok: true });
  const coded = await snapshot();
  expect(coded.elements).toContainEqual(expect.objectContaining({ name: "Authentication code", value: "[redacted]" }));
  expect(await perform({ action: "click", ref: ref(coded, "Verify") })).toMatchObject({ ok: true });
  const done = await snapshot();
  expect(done.text).toContain("Welcome back");
  expect(done.text).toContain("Signed in as admin");
  ref(done, "Open [redacted]");
  expect(await perform({ action: "screenshot" })).toMatchObject({ ok: false, code: "sensitive" });
  await preview.getByRole("button", { name: /Evidence/u }).click();
  const evidence = preview.getByRole("list", { name: "Browser evidence timeline" });
  await expect(evidence.getByRole("listitem").filter({ hasText: "Console error" }).last())
    .toContainText("Sensitive console detail hidden");
  for (const value of SENTINELS) await expect(evidence).not.toContainText(value);
  await preview.getByRole("button", { name: "Close Browser evidence" }).click();
}
