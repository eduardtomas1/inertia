// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import {
  closeWorkspaceTools,
  ensureWorkspaceTools,
  rightPanelToggle,
  selectWorkspaceTool,
} from "./support/workspace-tools";

type Command =
  | { action: "snapshot" | "screenshot" | "tabs" }
  | { action: "navigate"; url: string }
  | { action: "click"; ref: string }
  | { action: "type"; ref: string; text: string; replace: boolean }
  | { action: "wait"; text?: string; state: "present" | "absent"; timeoutMs: number };

interface Result {
  ok: boolean;
  code?: string;
  message?: string;
  text?: string;
  state?: { activeTabId: string; tabs: Array<{ id: string; url: string; loading: boolean }> };
}

interface PageSnapshot {
  blank?: boolean;
  nextStep?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  notInspected?: string[];
  viewport?: { width: number; height: number };
  elements?: Array<{ ref?: string; role: string; name: string; notInspected?: boolean }>;
}

const backgroundConversationId = "77777777-7777-4777-8777-777777777777";
let app!: AppFixture;
let page!: AppFixture["page"];
let conversationId = "";

async function browser(id: string, command: Command): Promise<Result> {
  return await app.electronApp.evaluate(async (_electron, request) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (conversationId: string, command: unknown) => Promise<Result>;
    };
    return await runtime.agentBrowser(request.id, request.command);
  }, { id, command });
}

function parsed(result: Result): PageSnapshot {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return JSON.parse(result.text ?? "{}") as PageSnapshot;
}

function refFor(snapshot: PageSnapshot, name: string): string {
  const ref = snapshot.elements?.find((element) => element.name === name)?.ref;
  expect(ref, `${name} in ${JSON.stringify(snapshot.elements)}`).toBeTruthy();
  return ref!;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function pageValue<Value>(url: string, expression: string): Promise<Value> {
  return await app.electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find(
      (candidate) => candidate.getURL() === request.url,
    );
    return await contents?.executeJavaScript(request.expression, true) as Value;
  }, { url, expression });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-reliability",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) {
          throw new Error("The Agent Browser reliability fixture needs a conversation.");
        }
        conversationId = conversation.id;
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("an agent can browse without the Browser panel, through a login, and on pages with frames and shadow roots", async () => {
  await expect(rightPanelToggle(page)).toHaveAttribute("aria-pressed", "false");

  const blank = parsed(await browser(conversationId, { action: "snapshot" }));
  expect(blank).toMatchObject({ blank: true, nextStep: expect.stringContaining("navigate") });

  const asyncUrl = `${app.previewUrl}agent-browser-async-page`;
  await expect(browser(conversationId, { action: "navigate", url: asyncUrl }))
    .resolves.toMatchObject({ ok: true });
  const hidden = parsed(await browser(conversationId, { action: "snapshot" }));
  expect(hidden.viewport).toMatchObject({ width: 1_280, height: 800 });
  expect(hidden.title).toBe("Async page");
  await expect(browser(conversationId, { action: "click", ref: refFor(hidden, "Load more") }))
    .resolves.toMatchObject({ ok: true });
  await expect(pageValue<number>(asyncUrl, "window.__loads")).resolves.toBe(1);
  expect(await app.nativePreviewIsVisible(asyncUrl)).toBe(false);

  expect(parsed(await browser(conversationId, {
    action: "wait", text: "report ready", state: "present", timeoutMs: 8_000,
  }))).toMatchObject({ matched: true });
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "Loading report", state: "absent", timeoutMs: 2_000,
  }))).toMatchObject({ matched: true });
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "never rendered", state: "present", timeoutMs: 600,
  }))).toMatchObject({ matched: false, nextStep: expect.any(String) });
  expect(parsed(await browser(conversationId, {
    action: "wait", state: "present", timeoutMs: 5_000,
  }))).toMatchObject({ matched: true });

  await expect(browser(conversationId, {
    action: "navigate", url: `${app.previewUrl}agent-browser-reloading-page`,
  })).resolves.toMatchObject({ ok: true });
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "Build finished", state: "present", timeoutMs: 8_000,
  }))).toMatchObject({ matched: true });
  await expect(browser(conversationId, { action: "navigate", url: asyncUrl }))
    .resolves.toMatchObject({ ok: true });
  const reopened = parsed(await browser(conversationId, { action: "snapshot" }));
  await expect(browser(conversationId, { action: "click", ref: refFor(reopened, "Load more") }))
    .resolves.toMatchObject({ ok: true });
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "report ready", state: "present", timeoutMs: 8_000,
  }))).toMatchObject({ matched: true });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
  const whileSettings = parsed(await browser(conversationId, { action: "snapshot" }));
  expect(whileSettings.text).toContain("Report ready");
  await expect(browser(conversationId, { action: "click", ref: refFor(whileSettings, "Loaded 1") }))
    .resolves.toMatchObject({ ok: true });
  await expect(pageValue<number>(asyncUrl, "window.__loads")).resolves.toBe(2);

  const backgroundUrl = `${app.previewUrl}agent-browser-large-page`;
  await expect(browser(backgroundConversationId, { action: "navigate", url: backgroundUrl }))
    .resolves.toMatchObject({ ok: true });
  const large = parsed(await browser(backgroundConversationId, { action: "snapshot" }));
  expect(large.truncated).toBe(true);
  expect(large.notInspected).toBeUndefined();
  await expect(browser(backgroundConversationId, { action: "click", ref: refFor(large, "Top action") }))
    .resolves.toMatchObject({ ok: true });
  await expect(pageValue<boolean>(backgroundUrl, "window.__topClicked")).resolves.toBe(true);
  await expect(browser(backgroundConversationId, {
    action: "navigate", url: `${app.previewUrl}agent-browser-large-credential`,
  })).resolves.toMatchObject({ ok: true });
  const lateCredential = await browser(backgroundConversationId, { action: "snapshot" });
  expect(lateCredential).toMatchObject({ ok: true });
  expect(JSON.stringify(lateCredential)).not.toContain("late-password-sentinel");
  await expect(pageValue<number>(asyncUrl, "window.__loads")).resolves.toBe(2);

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const tools = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(tools, "Browser");
  await expect(tools.getByRole("textbox", { name: "Preview address" })).toHaveValue(asyncUrl);
  await expect.poll(() => app.nativePreviewIsVisible(asyncUrl)).toBe(true);
  await expect(pageValue<number>(asyncUrl, "window.__loads")).resolves.toBe(2);
  let shown: PageSnapshot = {};
  await expect.poll(async () => {
    shown = parsed(await browser(conversationId, { action: "snapshot" }));
    return shown.viewport?.width;
  }).not.toBe(1_280);
  expect(shown.viewport?.width).toBeGreaterThan(0);

  await closeWorkspaceTools(page);
  await expect.poll(() => app.nativePreviewIsVisible(asyncUrl)).toBe(false);
  const closed = parsed(await browser(conversationId, { action: "snapshot" }));
  expect(closed.viewport).toEqual(shown.viewport);
  await expect(browser(conversationId, { action: "click", ref: refFor(closed, "Loaded 2") }))
    .resolves.toMatchObject({ ok: true });
  await expect(pageValue<number>(asyncUrl, "window.__loads")).resolves.toBe(3);

  const loginUrl = `${app.previewUrl}agent-browser-login`;
  await expect(browser(conversationId, { action: "navigate", url: loginUrl }))
    .resolves.toMatchObject({ ok: true });
  const login = parsed(await browser(conversationId, { action: "snapshot" }));
  await expect(browser(conversationId, {
    action: "type", ref: refFor(login, "Username"), text: "admin", replace: true,
  })).resolves.toMatchObject({ ok: true });
  await expect(browser(conversationId, {
    action: "type", ref: refFor(login, "Password"), text: "login-password-sentinel", replace: true,
  })).resolves.toMatchObject({ ok: true });
  const filled = await browser(conversationId, { action: "snapshot" });
  expect(JSON.stringify(filled)).not.toContain("login-password-sentinel");
  const redacted = parsed(filled);
  expect(redacted.elements).toContainEqual(expect.objectContaining({ name: "Password", value: "[redacted]" }));
  await expect(browser(conversationId, { action: "click", ref: refFor(redacted, "Sign in") }))
    .resolves.toMatchObject({ ok: true });
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "Welcome back", state: "present", timeoutMs: 8_000,
  }))).toMatchObject({ matched: true });
  const workspace = await browser(conversationId, { action: "snapshot" });
  const signedIn = parsed(workspace);
  expect(signedIn.title).toBe("Workspace");
  expect(signedIn.text).toContain("Welcome back");
  expect(signedIn.notInspected).toEqual(["frames", "shadow-roots"]);
  expect(signedIn.elements).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "frame", name: "Help", notInspected: true }),
    expect.objectContaining({ name: "Open report", ref: expect.stringMatching(/^e\d+$/u) }),
  ]));
  expect(JSON.stringify(workspace)).not.toContain("login-password-sentinel");
  expect(JSON.stringify(workspace)).not.toContain("frame-only-sentinel");
  await expect(browser(conversationId, { action: "screenshot" })).resolves.toMatchObject({ ok: true });

  const shadowUrl = `${app.previewUrl}agent-browser-shadow-coverage`;
  await expect(browser(conversationId, { action: "navigate", url: shadowUrl }))
    .resolves.toMatchObject({ ok: true });
  const shadow = parsed(await browser(conversationId, { action: "snapshot" }));
  expect(shadow.notInspected).toEqual(["shadow-roots"]);
  await expect(browser(conversationId, { action: "click", ref: refFor(shadow, "Save changes") }))
    .resolves.toMatchObject({ ok: true });
  await expect(pageValue<boolean>(shadowUrl, "window.__saved")).resolves.toBe(true);
  expect(parsed(await browser(conversationId, {
    action: "wait", text: "Saved", state: "present", timeoutMs: 4_000,
  }))).toMatchObject({ matched: true });

  await expect(browser(conversationId, { action: "navigate", url: `http://127.0.0.1:${await closedPort()}/` }))
    .resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: expect.stringContaining("connection refused"),
    });
  await expect(browser(conversationId, { action: "navigate", url: "http://127.0.0.1:9/" }))
    .resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: expect.stringContaining("different port"),
    });
  await expect(browser(conversationId, { action: "snapshot" })).resolves.toMatchObject({
    ok: false,
    code: "unavailable",
    message: expect.stringContaining("browser error page"),
  });
  await expect(browser(conversationId, { action: "navigate", url: shadowUrl }))
    .resolves.toMatchObject({ ok: true });
  expect(parsed(await browser(conversationId, { action: "snapshot" })).title).toBe("Shadow coverage");
  await expect(browser(conversationId, { action: "navigate", url: "https://example.com/" }))
    .resolves.toMatchObject({ ok: false, code: "invalid" });
  const redirected = await browser(conversationId, {
    action: "navigate", url: `${app.previewUrl}agent-browser-remote-redirect`,
  });
  expect(redirected, JSON.stringify(redirected)).toMatchObject({ ok: false, code: "unavailable" });
  expect(parsed(await browser(conversationId, { action: "snapshot" })).title).toBe("Shadow coverage");

  expect(app.rendererErrors).toEqual([]);
});
