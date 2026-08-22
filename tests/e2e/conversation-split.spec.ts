import { expect, test, type Locator } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { expectDocumentStartPrivacyGuard, expectFocusNavigationSettlement, expectHoverRetargetingGuard, expectMicrotaskFocusTheftBlocked, expectSemanticClickBoundaries } from "./support/agent-browser-security";
import { selectWorkspaceTool } from "./support/workspace-tools";

let app!: AppFixture;
let page!: AppFixture["page"];
let primaryConversationId = "";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "conversation-split",
    initialState: "conversation",
    windowDisplay: "primary",
    seedSecondProject: true,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      for (const conversation of store.snapshot().conversations) {
        const pane = conversation.title.endsWith("companion")
          ? "secondary"
          : "primary";
        if (pane === "primary") primaryConversationId = conversation.id;
        store.createMessage(
          conversation.id,
          `\`\`\`ts\nconst pane = "${pane}";\n\`\`\``,
          "assistant",
        );
        const timestamp = new Date().toISOString();
        store.upsertAgentGoal({
          conversationId: conversation.id,
          source: "inertia-local",
          providerSessionId: null,
          objective: pane === "primary"
            ? "Primary chat objective"
            : "Secondary chat objective",
          status: "active",
          tokenBudget: null,
          tokensUsed: null,
          timeUsedSeconds: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          synchronizedAt: null,
        });
      }
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

async function openPaneTool(
  pane: Locator,
  chatTitle: string,
  tab: "Changes" | "Files" | "Terminal" | "Goal" | "Preview",
): Promise<Locator> {
  const tools = pane.getByRole("complementary", { name: "Workspace tools" });
  if (!await tools.isVisible().catch(() => false)) {
    await pane.getByRole("button", {
      name: `Open tools for ${chatTitle}`,
    }).click();
  }
  await selectWorkspaceTool(tools, tab);
  return tools;
}

test("keeps cross-project chats, tools, and terminals independently scoped", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1440, 920);
  await page.keyboard.press("Escape");

  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  const primaryTitle = "conversation-split fixture";
  const secondaryTitle = "conversation-split companion";

  await sidebar.getByRole("button", { name: "Expand Companion" }).click();
  await sidebar.getByRole("button", {
    name: `Thread actions for ${secondaryTitle}`,
  }).click();
  await sidebar.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();

  const split = page.getByRole("main", {
    name: "Split conversation workspace",
  });
  let primary = page.getByRole("region", {
    name: `Primary chat: Inertia · ${primaryTitle}`,
  });
  let secondary = page.getByRole("region", {
    name: `Second chat: Companion · ${secondaryTitle}`,
  });
  await expect(split).toBeVisible();
  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  const primaryCode = primary.locator(".response-code-block");
  const secondaryCode = secondary.locator(".response-code-block");
  await expect(primaryCode).toHaveCount(1);
  await expect(secondaryCode).toHaveCount(1);
  const primaryWrap = primaryCode.getByRole("button", { name: "Wrap" });
  await primaryWrap.click();
  await expect(primaryCode.locator("pre")).toHaveClass(/wraps/u);
  await expect(secondaryCode.locator("pre")).not.toHaveClass(/wraps/u);
  await app.electronApp.evaluate(({ clipboard }) =>
    clipboard.writeText("split-clipboard-sentinel"));
  await secondaryCode.locator('button[title="Copy code"]').click();
  await expect.poll(() => app.electronApp.evaluate(({ clipboard }) =>
    clipboard.readText())).toBe('const pane = "secondary";');
  const duplicateIds = await page.locator("[id]").evaluateAll((elements) => {
    const counts = new Map<string, number>();
    for (const element of elements) {
      counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
  });
  expect(duplicateIds).toEqual([]);

  const primaryMessage = primary.getByRole("textbox", { name: "Message" });
  const secondaryMessage = secondary.getByRole("textbox", { name: "Message" });
  await expect(primary.getByRole("button", {
    name: /Local objective/u,
  })).toHaveCount(0);
  await expect(secondary.getByRole("button", {
    name: /Local objective/u,
  })).toHaveCount(0);
  await expect(primary.getByRole("complementary", {
    name: "Workspace tools",
  })).not.toBeVisible();
  await expect(secondary.getByRole("complementary", {
    name: "Workspace tools",
  })).not.toBeVisible();

  await primaryMessage.fill("/goal");
  await primary.getByRole("option", { name: /^\/goal/u }).click();
  const primaryGoalSurface = primary.getByRole("region", {
    name: "Codex goal",
  });
  await expect(primaryGoalSurface).toContainText(
    "One separately tracked goal",
  );
  await expect(primaryGoalSurface).not.toContainText("Primary chat objective");
  await expect(secondary.getByRole("region", {
    name: "Codex goal",
  })).toHaveCount(0);
  await expect(primary.getByRole("complementary", {
    name: "Workspace tools",
  })).not.toBeVisible();
  const chatGoalScreenshot = testInfo.outputPath(
    "cross-project-split-chat-goal.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: chatGoalScreenshot,
  });
  await testInfo.attach("cross-project-split-chat-goal", {
    path: chatGoalScreenshot,
    contentType: "image/png",
  });
  await expect(secondary.getByRole("region", {
    name: "Codex goal",
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(primaryGoalSurface).toHaveCount(0);
  await expect(primaryMessage).toBeFocused();

  await primaryMessage.fill("Draft owned by Inertia");
  await secondaryMessage.fill("Draft owned by Companion");
  await expect(primaryMessage).toHaveValue("Draft owned by Inertia");
  await expect(secondaryMessage).toHaveValue("Draft owned by Companion");

  await primary.getByRole("button", { name: "Scratch prompts" }).click();
  await primary.getByRole("menu", { name: "Scratch prompts" })
    .getByRole("menuitem", { name: /Save current prompt/u })
    .click();
  await expect(primaryMessage).toHaveValue("");
  const secondaryStash = secondary.getByRole("button", {
    name: "Scratch prompts, 1 saved",
  });
  await expect(secondaryStash).toBeVisible();
  await secondaryStash.click();
  await secondary.getByRole("menu", { name: "Scratch prompts" })
    .getByRole("menuitem", { name: /^Draft owned by Inertia/u })
    .click();
  await expect(secondaryMessage).toHaveValue("Draft owned by Inertia");
  await expect(primary.getByRole("button", {
    name: "Scratch prompts, 1 saved",
  })).toBeVisible();
  await primaryMessage.fill("Draft owned by Inertia");
  await secondaryMessage.fill("Draft owned by Companion");

  await secondary.getByRole("button", { name: "Send message" }).click();
  await expect(split).toBeVisible();
  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await expect(primaryMessage).toHaveValue("Draft owned by Inertia");
  await expect(
    secondary.getByText("Draft owned by Companion", { exact: true }),
  ).toBeVisible();
  await secondaryMessage.fill("Draft owned by Companion");

  const primaryGoal = await openPaneTool(primary, primaryTitle, "Goal");
  const secondaryGoal = await openPaneTool(
    secondary,
    secondaryTitle,
    "Goal",
  );
  await expect(primaryGoal.getByRole("region", {
    name: "Goals and agent workflows",
  })).toBeVisible();
  await expect(secondaryGoal.getByRole("region", {
    name: "Goals and agent workflows",
  })).toBeVisible();
  await expect(primaryGoal.getByText("Inertia local", { exact: true }))
    .toBeVisible();
  await expect(secondaryGoal.getByText("Inertia local", { exact: true }))
    .toBeVisible();
  const goalDuplicateIds = await page.locator("[id]").evaluateAll(
    (elements) => {
      const counts = new Map<string, number>();
      for (const element of elements) {
        counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
      }
      return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id);
    },
  );
  expect(goalDuplicateIds).toEqual([]);
  const goalSplitScreenshot = testInfo.outputPath(
    "cross-project-split-goals.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: goalSplitScreenshot,
  });
  await testInfo.attach("cross-project-split-goals", {
    path: goalSplitScreenshot,
    contentType: "image/png",
  });

  const primaryFiles = await openPaneTool(primary, primaryTitle, "Files");
  await expect(
    primaryFiles.getByRole("treeitem", { name: "sample.ts", exact: true }),
  ).toBeVisible();
  await expect(
    primaryFiles.getByRole("treeitem", { name: "beta-only.ts", exact: true }),
  ).toHaveCount(0);

  const secondaryFiles = await openPaneTool(
    secondary,
    secondaryTitle,
    "Files",
  );
  await expect(
    secondaryFiles.getByRole("treeitem", {
      name: "beta-only.ts",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    secondaryFiles.getByRole("treeitem", { name: "sample.ts", exact: true }),
  ).toHaveCount(0);

  const primaryChanges = await openPaneTool(primary, primaryTitle, "Changes");
  const primaryChangedFiles = primaryChanges.getByRole("navigation", {
    name: "Git repositories and changed files",
  });
  await expect(primaryChangedFiles.getByText("sample.ts", { exact: true }))
    .toBeVisible();
  await expect(primaryChangedFiles.getByText("beta-only.ts", { exact: true }))
    .toHaveCount(0);

  const secondaryChanges = await openPaneTool(
    secondary,
    secondaryTitle,
    "Changes",
  );
  const secondaryChangedFiles = secondaryChanges.getByRole("navigation", {
    name: "Git repositories and changed files",
  });
  await expect(secondaryChangedFiles.getByText("beta-only.ts", { exact: true }))
    .toBeVisible();
  await expect(secondaryChangedFiles.getByText("sample.ts", { exact: true }))
    .toHaveCount(0);

  const primaryTerminal = await openPaneTool(
    primary,
    primaryTitle,
    "Terminal",
  );
  const secondaryTerminal = await openPaneTool(
    secondary,
    secondaryTitle,
    "Terminal",
  );
  const primarySession = primaryTerminal.locator(
    ".terminal-panel[data-terminal-id]",
  );
  const secondarySession = secondaryTerminal.locator(
    ".terminal-panel[data-terminal-id]",
  );
  await expect(primarySession).toHaveAttribute("data-terminal-id", /.+/u);
  await expect(secondarySession).toHaveAttribute("data-terminal-id", /.+/u);
  const primaryTerminalId =
    await primarySession.getAttribute("data-terminal-id");
  const secondaryTerminalId =
    await secondarySession.getAttribute("data-terminal-id");
  expect(primaryTerminalId).not.toBe(secondaryTerminalId);
  await expect(primaryTerminal.getByText("Inertia", { exact: true }))
    .toBeVisible();
  await expect(secondaryTerminal.getByText("Companion", { exact: true }))
    .toBeVisible();

  const wideScreenshot = testInfo.outputPath(
    "cross-project-split-independent-tools.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: wideScreenshot,
  });
  await testInfo.attach("cross-project-split-independent-tools", {
    path: wideScreenshot,
    contentType: "image/png",
  });

  const primaryPreview = await openPaneTool(
    primary,
    primaryTitle,
    "Preview",
  );
  const secondaryPreview = await openPaneTool(
    secondary,
    secondaryTitle,
    "Preview",
  );
  const primaryPreviewUrl = `${app.previewUrl}primary-project`;
  const secondaryPreviewUrl = `${app.previewUrl}companion-project`;
  await primaryPreview.getByRole("textbox", {
    name: "Preview address",
  }).fill(primaryPreviewUrl);
  await primaryPreview.getByRole("button", { name: "Go", exact: true }).click();
  await secondaryPreview.getByRole("textbox", {
    name: "Preview address",
  }).fill(secondaryPreviewUrl);
  await secondaryPreview.getByRole("button", {
    name: "Go",
    exact: true,
  }).click();
  await expect(primaryPreview.getByRole("textbox", {
    name: "Preview address",
  })).toHaveValue(primaryPreviewUrl);
  await expect(secondaryPreview.getByRole("textbox", {
    name: "Preview address",
  })).toHaveValue(secondaryPreviewUrl);
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, urls) => urls.every((url) =>
      webContents.getAllWebContents().some((contents) =>
        contents.getURL() === url)),
    [primaryPreviewUrl, secondaryPreviewUrl],
  )).toBe(true);
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, urls) => urls.map((url) => webContents.getAllWebContents()
      .find((contents) => contents.getURL() === url)?.navigationHistory.canGoBack()),
    [primaryPreviewUrl, secondaryPreviewUrl],
  )).toEqual([false, false]);
  const previewStorageIsolation = await app.electronApp.evaluate(
    async ({ BrowserWindow }, urls) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return null;
      const previews = window.contentView.children
        .map((view) => Reflect.get(view, "webContents") as
          | {
            getURL: () => string;
            executeJavaScript: (code: string) => Promise<unknown>;
          }
          | undefined)
        .filter((contents): contents is NonNullable<typeof contents> =>
          Boolean(contents && urls.includes(contents.getURL())));
      const primaryContents = previews.find(
        (contents) => contents.getURL() === urls[0],
      );
      const secondaryContents = previews.find(
        (contents) => contents.getURL() === urls[1],
      );
      if (!primaryContents || !secondaryContents) return null;
      await primaryContents.executeJavaScript(`
        localStorage.setItem("inertia-preview-isolation", "primary");
        document.cookie = "inertia-preview-isolation=primary; path=/";
      `);
      return await secondaryContents.executeJavaScript(`({
        local: localStorage.getItem("inertia-preview-isolation"),
        cookie: document.cookie
      })`);
    },
    [primaryPreviewUrl, secondaryPreviewUrl],
  );
  expect(previewStorageIsolation).toEqual({
    local: null,
    cookie: "",
  });
  await primaryPreview.getByRole("button", { name: "Open browser page" }).click();
  const browserTabs = primaryPreview.locator(".preview-tabs").getByRole("tab");
  await expect(browserTabs).toHaveCount(2);
  const secondPrimaryPreviewUrl = `${app.previewUrl}agent-browser-page`;
  await primaryPreview.getByRole("textbox", {
    name: "Preview address",
  }).fill(secondPrimaryPreviewUrl);
  await primaryPreview.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url,
    ),
    secondPrimaryPreviewUrl,
  )).toBe(true);
  await expect(primaryPreview.locator(".preview-tab-shell.active"))
    .toContainText("Agent browser source");
  const semanticSnapshot = await app.electronApp.evaluate(
    async (_electron, conversationId) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "snapshot" },
        ) => Promise<{ ok: boolean; text?: string }>;
      };
      return await runtime.agentBrowser(conversationId, { action: "snapshot" });
    },
    primaryConversationId,
  );
  expect(semanticSnapshot.ok).toBe(true);
  const semanticElements = JSON.parse(semanticSnapshot.text ?? "{}") as {
    elements?: Array<{ ref?: string; name?: string }>;
  };
  const hoverRef = semanticElements.elements?.find((element) => element.name === "Hover-moving action")?.ref;
  expect(hoverRef).toMatch(/^e\d+$/u);
  await expectHoverRetargetingGuard(app, primaryConversationId, secondPrimaryPreviewUrl, hoverRef!);
  await expectSemanticClickBoundaries(app, primaryConversationId, secondPrimaryPreviewUrl);
  const navigationRef = semanticElements.elements?.find(
    (element) => element.name === "Continue in Browser",
  )?.ref;
  expect(navigationRef).toMatch(/^e\d+$/u);
  const clickResult = await app.electronApp.evaluate(
    async (_electron, request) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "click"; ref: string },
        ) => Promise<{ ok: boolean }>;
      };
      return await runtime.agentBrowser(request.conversationId, {
        action: "click",
        ref: request.ref,
      });
    },
    { conversationId: primaryConversationId, ref: navigationRef! },
  );
  expect(clickResult.ok).toBe(true);
  const browserDestinationUrl = `${app.previewUrl}agent-browser-destination`;
  expect(await app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url,
    ),
    browserDestinationUrl,
  )).toBe(true);
  expect(await app.electronApp.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(
        (candidate) => candidate.getURL() === url,
      );
      return await contents?.executeJavaScript(`(() => {
        const input = document.querySelector("input[name='query']");
        if (!(input instanceof HTMLInputElement)) return false;
        input.value = "inertia";
        input.focus();
        return document.activeElement === input;
      })()`);
    },
    browserDestinationUrl,
  )).toBe(true);
  await expect(app.electronApp.evaluate(
    async (_electron, conversationId) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "press"; key: "Enter" },
        ) => Promise<{ ok: boolean }>;
      };
      return await runtime.agentBrowser(conversationId, {
        action: "press",
        key: "Enter",
      });
    },
    primaryConversationId,
  )).resolves.toMatchObject({ ok: true });
  const keyDestinationUrl = `${app.previewUrl}agent-browser-key-destination?query=inertia`;
  const currentPreviewUrls = await app.electronApp.evaluate(
    ({ webContents }, origin) => webContents.getAllWebContents()
      .map((contents) => contents.getURL())
      .filter((url) => url.startsWith(origin)),
    app.previewUrl,
  );
  expect(currentPreviewUrls).toContain(keyDestinationUrl);
  const typeResult = await app.electronApp.evaluate(
    async (_electron, conversationId) => {
      type Command =
        | { action: "snapshot" }
        | { action: "type"; ref: string; text: string; replace: boolean };
      type Result = { ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(conversationId, { action: "snapshot" });
      if (!snapshot.ok || !snapshot.text) return { ok: false, stage: "snapshot" };
      const parsed = JSON.parse(snapshot.text) as {
        elements: Array<{ name: string; ref: string }>;
      };
      const ref = parsed.elements.find((element) => element.name === "Type destination")?.ref;
      if (!ref) return { ok: false, stage: "ref" };
      return await runtime.agentBrowser(conversationId, {
        action: "type",
        ref,
        text: "inertia",
        replace: true,
      });
    },
    primaryConversationId,
  );
  expect(typeResult).toMatchObject({ ok: true });
  const typeDestinationUrl = `${app.previewUrl}agent-browser-type-destination?query=inertia`;
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url
        && contents.getTitle() === "Agent browser type destination",
    ),
    typeDestinationUrl,
  )).toBe(true);
  await expectMicrotaskFocusTheftBlocked(app, primaryConversationId, typeDestinationUrl);
  expect(await app.electronApp.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(
        (candidate) => candidate.getURL() === url,
      );
      return await contents?.executeJavaScript(`(() => {
        const input = document.querySelector("input[type='file']");
        if (!(input instanceof HTMLInputElement)) return false;
        input.focus();
        return document.activeElement === input;
      })()`);
    },
    typeDestinationUrl,
  )).toBe(true);
  await expect(app.electronApp.evaluate(
    async (_electron, conversationId) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "press"; key: "Enter" },
        ) => Promise<{ code?: string; ok: boolean }>;
      };
      return await runtime.agentBrowser(conversationId, {
        action: "press",
        key: "Enter",
      });
    },
    primaryConversationId,
  )).resolves.toMatchObject({ ok: false, code: "invalid" });
  await expect(app.electronApp.evaluate(
    async (_electron, conversationId) => {
      type Command =
        | { action: "snapshot" }
        | { action: "click"; ref: string };
      type Result = { ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(conversationId, { action: "snapshot" });
      if (!snapshot.ok || !snapshot.text) return { ok: false, stage: "snapshot" };
      const parsed = JSON.parse(snapshot.text) as {
        elements: Array<{ name: string; ref: string }>;
      };
      const ref = parsed.elements.find(
        (element) => element.name === "Choose through page handler",
      )?.ref;
      if (!ref) return { ok: false, stage: "ref" };
      return await runtime.agentBrowser(conversationId, { action: "click", ref });
    },
    primaryConversationId,
  )).resolves.toMatchObject({ ok: true });
  await expect.poll(() => app.electronApp.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(
        (candidate) => candidate.getURL() === url,
      );
      if (!contents) return null;
      return {
        attached: contents.debugger.isAttached(),
        invoked: await contents.executeJavaScript(
          "window.__delayedPickerInvoked === true",
        ),
        selectedFiles: await contents.executeJavaScript(
          "document.querySelector('input[type=file]')?.files?.length ?? -1",
        ),
      };
    },
    typeDestinationUrl,
  )).toEqual({ attached: true, invoked: true, selectedFiles: 0 });
  await expectFocusNavigationSettlement(app, primaryConversationId,
    `${app.previewUrl}agent-browser-focus-destination`);
  const privacyUrl = `${app.previewUrl}agent-browser-privacy-start`;
  await expectDocumentStartPrivacyGuard(app, primaryConversationId, privacyUrl);
  for (const [path, secret] of [
    ["agent-browser-nested-privacy-start", "nested-password-sentinel"],
    ["agent-browser-frame-lifetime-privacy", "removed-frame-password-sentinel"],
    ["agent-browser-shadow-lifetime-privacy", "removed-shadow-password-sentinel"],
    ["agent-browser-declarative-shadow-privacy", "declarative-shadow-password-sentinel"],
    ["agent-browser-declarative-closed-privacy", "declarative-closed-password-sentinel"],
    ["agent-browser-declarative-detached-privacy", "detached-declarative-password-sentinel"],
    ["agent-browser-trusted-types-declarative-detached-privacy", "trusted-types-declarative-password-sentinel"],
  ]) await expectDocumentStartPrivacyGuard(app, primaryConversationId, `${app.previewUrl}${path}`, secret);
  const browserPagesScreenshot = testInfo.outputPath("inertia-browser-pages.png");
  await page.screenshot({ animations: "disabled", path: browserPagesScreenshot });
  await testInfo.attach("inertia-browser-pages", {
    path: browserPagesScreenshot,
    contentType: "image/png",
  });
  await primaryPreview.locator(".preview-tab-shell.active .preview-tab-close").click();
  await expect(browserTabs).toHaveCount(1);
  await expect.poll(() => app.nativePreviewIsVisible(primaryPreviewUrl)).toBe(true);
  await app.electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, app.attachmentImagePath);
  await primary.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }).click();
  await primary.getByRole("button", {
    name: "Preview attachment preview.png",
  }).click();
  const attachmentDialog = page.getByRole("dialog", { name: "preview.png" });
  await expect(attachmentDialog).toBeVisible();
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, urls) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return false;
      const previews = window.contentView.children
        .filter((view) => {
          const contents = Reflect.get(view, "webContents") as
            | { getURL: () => string }
            | undefined;
          return contents && urls.includes(contents.getURL());
        });
      return previews.length === 2 && previews.every((view) => {
          const bounds = view.getBounds();
          return bounds.width === 0 && bounds.height === 0;
        });
    },
    [primaryPreviewUrl, secondaryPreviewUrl],
  )).toBe(true);
  await attachmentDialog.getByRole("button", {
    name: "Close preview of preview.png",
  }).click();
  await expect.poll(() => app.electronApp.evaluate(
    ({ BrowserWindow }, urls) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return false;
      const previews = window.contentView.children
        .filter((view) => {
          const contents = Reflect.get(view, "webContents") as
            | { getURL: () => string }
            | undefined;
          return contents && urls.includes(contents.getURL());
        });
      return previews.length === 2 && previews.every((view) => {
          const bounds = view.getBounds();
          return bounds.width > 0 && bounds.height > 0;
        });
    },
    [primaryPreviewUrl, secondaryPreviewUrl],
  )).toBe(true);
  await primaryPreview.getByRole("tab", {
    name: "Terminal",
    exact: true,
  }).click();
  await secondaryPreview.getByRole("tab", {
    name: "Terminal",
    exact: true,
  }).click();

  await sidebar.locator("button.conversation-row")
    .filter({ hasText: secondaryTitle })
    .click();
  primary = page.getByRole("region", {
    name: `Primary chat: Companion · ${secondaryTitle}`,
  });
  secondary = page.getByRole("region", {
    name: `Second chat: Inertia · ${primaryTitle}`,
  });
  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await expect(primary).toHaveAttribute(
    "id",
    "secondary-conversation-pane",
  );
  await expect(secondary).toHaveAttribute(
    "id",
    "primary-conversation-pane",
  );
  const promotedBounds = await primary.boundingBox();
  const demotedBounds = await secondary.boundingBox();
  expect(promotedBounds).not.toBeNull();
  expect(demotedBounds).not.toBeNull();
  expect(promotedBounds!.x).toBeLessThan(demotedBounds!.x);
  await expect(primary.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Draft owned by Companion");
  await expect(secondary.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Draft owned by Inertia");
  await expect(
    primary.getByRole("complementary", { name: "Workspace tools" })
      .getByText("Companion", { exact: true }),
  ).toBeVisible();
  await expect(
    secondary.getByRole("complementary", { name: "Workspace tools" })
      .getByText("Inertia", { exact: true }),
  ).toBeVisible();
  await expect(
    primary.locator(".terminal-panel[data-terminal-id]"),
  ).toHaveAttribute(
    "data-terminal-id",
    secondaryTerminalId ?? "",
  );
  await expect(
    secondary.locator(".terminal-panel[data-terminal-id]"),
  ).toHaveAttribute(
    "data-terminal-id",
    primaryTerminalId ?? "",
  );
  await expect(secondary.getByRole("button", {
    name: "Preview attachment preview.png",
  })).toBeVisible();
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, urls) => urls.every((url) =>
      webContents.getAllWebContents().some((contents) =>
        contents.getURL() === url)),
    [primaryPreviewUrl, secondaryPreviewUrl],
  )).toBe(true);

  await app.resizeWindow(760, 820);
  await expect.poll(() => page.evaluate(() =>
    window.matchMedia("(max-width: 860px)").matches)).toBe(true);
  await expect(page.getByRole("separator", {
    name: "Resize split chats",
  })).toHaveAttribute("aria-orientation", "horizontal");
  await expect(primary.getByRole("button", { name: "Send message" }))
    .toBeVisible();
  await expect(secondary.getByRole("button", { name: "Send message" }))
    .toBeVisible();
  await app.expectNoViewportOverflow();
  const narrowScreenshot = testInfo.outputPath(
    "cross-project-split-narrow.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: narrowScreenshot,
  });
  await testInfo.attach("cross-project-split-narrow", {
    path: narrowScreenshot,
    contentType: "image/png",
  });

  await primary.getByRole("button", {
    name: `Close split chat ${secondaryTitle}`,
  }).click();
  await expect(split).toHaveCount(0);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", {
    name: primaryTitle,
    level: 1,
  })).toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});
