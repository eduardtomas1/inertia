import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeMetadataScope } from "../../src/server/provider/metadata";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { MODEL_FAVORITES_STORAGE_KEY } from "../../src/renderer/src/utils/modelFavorites";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";
import { seedLargeModelCatalog } from "./support/model-catalog-fixture";

const execFileAsync = promisify(execFile);

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let runtimeSnapshot!: AppFixture["runtimeSnapshot"];
let resizeWindow!: AppFixture["resizeWindow"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "model-chooser",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      seedLargeModelCatalog(testDirectory, workspaceDirectory);
    },
  });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
  runtimeSnapshot = app.runtimeSnapshot;
  resizeWindow = app.resizeWindow;
});

test.afterAll(async () => {
  await app.close();
});

test("uses the anchored model chooser and enforces authoritative route boundaries", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  if (await page.getByRole("textbox", { name: "Message" }).count() === 0) {
    await expect.poll(
      async () => (await runtimeSnapshot()).phase,
      { timeout: 10_000 },
    ).toBe("ready");
    await expect(
      page.getByRole("complementary", { name: "Project navigation", exact: true })
        .locator(".sidebar-mode-switch")
        .getByRole("button", { name: "Projects", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    const addProject = page.getByRole("button", { name: "Add your first project" });
    await expect(addProject).toBeEnabled();
    await addProject.click();
    await expect(page.getByRole("heading", {
      name: /^What should we build in .+\?$/u,
      level: 3,
    })).toBeVisible();
    const newChat = page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    }).getByRole("button", { name: "New chat", exact: true });
    await expect(newChat).toBeVisible();
    await newChat.click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  }
  const workspaceHeader = page.locator(".workspace-header");
  const closeTools = workspaceHeader.getByRole("button", { name: "Close workspace tools" });
  if (await closeTools.isVisible() && await closeTools.isEnabled()) {
    await closeTools.click();
  }
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("@sam");
  await expect(page.getByRole("listbox", { name: "Project files" }).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await composer.fill("/p");
  await expect(page.getByRole("listbox", { name: "Composer commands" }).getByRole("option", { name: /plan/i })).toHaveAttribute("aria-selected", "true");
  await composer.fill("");
  await resizeWindow(1440, 720);

  const modelTrigger = page.getByRole("button", { name: /^Choose model\./u });
  const modelChooser = page.getByRole("dialog", { name: "Choose model" });
  const captureChooserScenario = async (name: string): Promise<void> => {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      path: screenshotPath,
      scale: "device",
    });
    await testInfo.attach(name, {
      path: screenshotPath,
      contentType: "image/png",
    });
  };

  await modelTrigger.click();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
  const chooserId = await modelTrigger.getAttribute("aria-controls");
  expect(chooserId).toBeTruthy();
  await expect(modelChooser).toHaveAttribute("id", chooserId!);
  await expect(modelChooser).toBeVisible();
  await expect(modelChooser.getByRole("navigation", { name: "Model sources" })).toBeVisible();
  const modelResults = modelChooser.getByRole("list", {
    name: "Model results",
  });
  const modelOptions = modelResults.locator(".model-chooser-row-option");
  const modelResultsAx = await modelResults.ariaSnapshot();
  expect(modelResultsAx).toContain('- list "Model results"');
  expect(modelResultsAx).toContain("- listitem:");
  expect(modelResultsAx).toContain('- button "Add ');
  await expect(modelResults.locator(
    ".model-chooser-row.is-active .model-chooser-row-option",
  )).toHaveAttribute("aria-current", "true");
  expect(await modelResults.locator(":scope > :not(li)").count()).toBe(0);
  await expect(modelChooser.getByRole("group", {
    name: "Model favorite actions",
  })).toHaveCount(0);
  const firstResult = modelChooser.locator(".model-chooser-result").first();
  await firstResult.evaluate((element) => {
    element.style.minHeight = "92px";
  });
  const rowCenters = await modelChooser.locator(".model-chooser-result")
    .evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    }));
  const favoriteCenters = await modelResults.locator(
    ".model-chooser-row-favorite",
  )
    .evaluateAll((elements) => elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    }));
  expect(favoriteCenters).toHaveLength(rowCenters.length);
  for (const [index, center] of rowCenters.entries()) {
    expect(Math.abs(center - favoriteCenters[index]!)).toBeLessThanOrEqual(1);
  }
  await firstResult.evaluate((element) => {
    element.style.removeProperty("min-height");
  });
  const searchModels = modelChooser.getByRole("searchbox", { name: "Search models" });
  await expect(searchModels).toBeFocused();
  const codexSource = modelChooser.getByRole("button", {
    name: /^Codex, \d+ models?$/u,
  });
  await expect(codexSource).toHaveAttribute("aria-pressed", "true");
  const claudeSource = modelChooser.getByRole("button", {
    name: /^Claude, \d+ models?$/u,
  });
  await claudeSource.click();
  await expect(searchModels).toBeFocused();
  const initialActiveDescendant = await searchModels.getAttribute(
    "aria-activedescendant",
  );
  await page.keyboard.press("End");
  await expect.poll(() => searchModels.getAttribute("aria-activedescendant"))
    .not.toBe(initialActiveDescendant);
  await page.keyboard.press("Home");
  await expect(searchModels).toHaveAttribute(
    "aria-activedescendant",
    initialActiveDescendant!,
  );
  const [headerBounds, modelChooserBounds] = await Promise.all([
    workspaceHeader.boundingBox(),
    modelChooser.boundingBox(),
  ]);
  expect(modelChooserBounds?.y ?? 0).toBeGreaterThanOrEqual(
    (headerBounds?.y ?? 0) + (headerBounds?.height ?? 0),
  );
  expect((modelChooserBounds?.x ?? 0) + (modelChooserBounds?.width ?? 0))
    .toBeLessThanOrEqual(1440);

  await captureChooserScenario("anchored-model-chooser-1440x720");

  const firstFavorite = modelResults.getByRole("button", {
    name: /^Add .+ to favorites$/u,
  }).first();
  await firstFavorite.click();
  await expect(modelResults.getByRole("button", {
    name: /^Remove .+ from favorites$/u,
  }).first()).toHaveAttribute("aria-pressed", "true");
  const favoritesSource = modelChooser.getByRole("button", {
    name: /^Favorites, 1 model$/u,
  });
  await expect(favoritesSource).toBeVisible();
  await favoritesSource.click();
  await expect(modelOptions).toHaveCount(1);
  await captureChooserScenario("model-chooser-favorites-1440x720");
  await claudeSource.click();
  await expect(claudeSource).toHaveAttribute("aria-pressed", "true");
  await captureChooserScenario("model-chooser-claude-1440x720");
  await searchModels.fill("Kimi K3");
  await expect(modelOptions.filter({ hasText: /Kimi/u }).first())
    .toBeVisible();
  await expect(modelOptions.filter({ hasText: /Codex/u }))
    .toHaveCount(0);
  await captureChooserScenario("model-chooser-search-kimi-1440x720");
  await searchModels.fill("route-that-does-not-exist");
  await expect(modelChooser.getByText("No matching models", { exact: true })).toBeVisible();
  await searchModels.fill("");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+1" : "Control+1");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "true");
  await modelTrigger.focus();
  await modelTrigger.press("Escape");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  await expect(modelChooser.getByRole("searchbox", { name: "Search models" }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modelChooser).toBeHidden();
  await expect(modelTrigger).toBeFocused();

  await modelTrigger.click();
  const modeTrigger = page.getByRole("button", { name: "Choose work mode" });
  const modeMenu = page.getByRole("menu", { name: "Work mode" });
  await modeTrigger.click();
  await expect(modelChooser).toBeHidden();
  await expect(modeMenu).toBeVisible();
  await expect(modeTrigger).toBeFocused();

  const currentMode = await modeTrigger.locator("span").first().textContent();
  const nextMode = currentMode === "Build" ? "Plan" : "Build";
  await modeMenu.getByRole("menuitemradio", { name: new RegExp(`^${nextMode}`) }).click();
  await expect(modeMenu).toBeHidden();
  await expect(modeTrigger).toBeFocused();
  await expect(modeTrigger.locator("span").first()).toHaveText(nextMode);

  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const currentBranch = (await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: workspaceDirectory },
  )).stdout.trim();
  expect(currentBranch).not.toBe("");
  const stateDatabase = new Database(databasePath, { readonly: true });
  const state = stateDatabase.prepare(
    "SELECT active_conversation_id FROM app_state WHERE id = 1",
  ).get() as { active_conversation_id: string };
  const conversationCountBefore = (stateDatabase.prepare(
    "SELECT COUNT(*) AS count FROM conversations",
  ).get() as { count: number }).count;
  stateDatabase.close();

  const runtimeStore = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const currentConversation = runtimeStore.conversation(state.active_conversation_id);
  const alpha = providerNativeModelSelection({
    providerId: "codex",
    modelId: "codex-alpha",
    alias: "Codex Alpha",
    reasoningEffort: "medium",
  });
  const alphaIdentity = continuationIdentityForSelection(alpha, null, false);
  const cachedAt = new Date().toISOString();
  runtimeStore.saveProviderMetadata({
    scope: providerNativeMetadataScope("codex"),
    models: [
      {
        id: "codex-alpha",
        label: "Codex Alpha",
        description: "First model in the E2E native catalog.",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "medium",
          label: "Medium",
          description: "Balanced reasoning.",
        }],
        defaultReasoningEffort: "medium",
      },
      {
        id: "codex-beta",
        label: "Codex Beta",
        description: "Second model in the E2E native catalog.",
        isDefault: false,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "medium",
          label: "Medium",
          description: "Balanced reasoning.",
        }],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-sol",
        label: "Sol",
        description: "Frontier coding model in the E2E native catalog.",
        isDefault: false,
        inputModalities: ["text"],
        reasoningOptions: [{
          value: "high",
          label: "High",
          description: "Thorough reasoning.",
        }, {
          value: "xhigh",
          label: "Extra high",
          description: "Maximum reasoning.",
        }],
        defaultReasoningEffort: "high",
      },
    ],
    modelsUpdatedAt: cachedAt,
    modelsLastAttemptedAt: cachedAt,
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  });
  runtimeStore.updateConversation(currentConversation.id, {
    providerId: "codex",
    modelSelection: alpha,
  });
  runtimeStore.updateConversation(currentConversation.id, {
    providerSessionId: "composer-e2e-session",
    continuationIdentity: alphaIdentity,
  });
  const requestedAt = new Date(Date.now() - 1_000).toISOString();
  const { turn } = runtimeStore.beginAgentTurn({
    conversationId: currentConversation.id,
    runId: `composer-e2e-${randomUUID()}`,
    providerId: "codex",
    modelSelection: alpha,
    continuationIdentity: alphaIdentity,
    reasoningEffort: "medium",
    interactionMode: currentConversation.interactionMode,
    accessMode: currentConversation.accessMode,
    providerSessionBefore: "composer-e2e-session",
    configurationRevision: 0,
    association: "authoritative",
    content: "Keep the authoritative Codex route.",
    requestedAt,
  });
  runtimeStore.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    providerSessionAfter: "composer-e2e-session",
    startedAt: requestedAt,
    completedAt: cachedAt,
    updatedAt: cachedAt,
  });
  runtimeStore.createTurnGitArtifact({
    id: `composer-e2e-artifact-${randomUUID()}`,
    turnId: turn.id,
    branch: currentBranch,
    createdAt: cachedAt,
  });
  runtimeStore.completeTurnGitArtifact(turn.id, {
    files: [],
    insertions: 0,
    deletions: 0,
    status: "ready",
    completeness: "complete",
    patchState: "none",
    capturedAt: cachedAt,
    updatedAt: cachedAt,
  });
  runtimeStore.close();

  const beforeRestart = await runtimeSnapshot();
  const appShell = page.locator(".app-shell");
  const rendererGenerationBeforeRestart = await appShell.getAttribute(
    "data-runtime-generation",
  );
  expect(rendererGenerationBeforeRestart).not.toBeNull();
  await app.recycleRuntime();
  await expect.poll(async () => {
    const current = await runtimeSnapshot();
    return current.phase === "ready" && current.generation > beforeRestart.generation;
  }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => {
    const generation = await appShell.getAttribute("data-runtime-generation");
    return generation && generation !== rendererGenerationBeforeRestart;
  }, { timeout: 10_000 }).toBe(true);
  await expect(appShell).toHaveAttribute("data-connection-status", "online", {
    timeout: 10_000,
  });
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(workspaceHeader.getByRole("button", {
    name: currentBranch,
    exact: true,
  })).toBeVisible();
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    try {
      return (database.prepare(`
        SELECT COUNT(*) AS count
        FROM workspace_runs
        WHERE conversation_id = ? AND status IN ('running', 'waiting')
      `).get(currentConversation.id) as { count: number }).count;
    } finally {
      database.close();
    }
  }).toBe(0);

  await page.evaluate((storageKey) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 2,
      favorites: [
        {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        {
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
      ],
    }));
  }, MODEL_FAVORITES_STORAGE_KEY);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(workspaceHeader.getByRole("button", {
    name: currentBranch,
    exact: true,
  })).toBeVisible();
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    try {
      return (database.prepare(`
        SELECT COUNT(*) AS count
        FROM workspace_runs
        WHERE conversation_id = ? AND status IN ('running', 'waiting')
      `).get(currentConversation.id) as { count: number }).count;
    } finally {
      database.close();
    }
  }).toBe(0);
  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await searchModels.fill("Sol");
  const solResults = modelOptions.filter({
    hasText: /^Sol/u,
  });
  await expect(solResults).toHaveCount(2);
  const solXhigh = solResults.filter({ hasText: /xhigh reasoning/u });
  await expect(solXhigh).toBeVisible();
  await captureChooserScenario("model-chooser-search-sol-1440x720");
  await solXhigh.click();
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare(`
      SELECT model_selection_json AS selection
      FROM conversations
      WHERE id = ?
    `).get(currentConversation.id) as { selection: string };
    database.close();
    const selection = JSON.parse(row.selection) as {
      modelId: string;
      reasoningEffort: string | null;
    };
    return {
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
    };
  }).toEqual({
    modelId: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  });
  await expect(modelTrigger).toHaveAccessibleName(
    /Current selection: Codex .* Model Sol \(gpt-5\.6-sol\) .* Reasoning xhigh/u,
  );

  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  await expect(modelResults.locator(
    ".model-chooser-row.is-active .model-chooser-row-option",
  )).toContainText("Sol");
  await searchModels.fill("Codex Beta");
  const codexBeta = modelOptions.filter({
    hasText: /^Codex Beta/u,
  });
  await expect(codexBeta).toBeEnabled();
  await codexBeta.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    const row = database.prepare(`
      SELECT active_conversation_id,
             (SELECT model_selection_json FROM conversations
              WHERE id = app_state.active_conversation_id) AS selection,
             (SELECT COUNT(*) FROM conversations) AS conversation_count
      FROM app_state
      WHERE id = 1
    `).get() as {
      active_conversation_id: string;
      selection: string;
      conversation_count: number;
    };
    database.close();
    return {
      activeId: row.active_conversation_id,
      modelId: (JSON.parse(row.selection) as { modelId: string }).modelId,
      conversationCount: row.conversation_count,
    };
  }).toEqual({
    activeId: currentConversation.id,
    modelId: "codex-beta",
    conversationCount: conversationCountBefore,
  });
  await expect(modelTrigger).toHaveAccessibleName(
    /Current selection: Codex .* Model Codex Beta \(codex-beta\)/u,
  );

  await modelTrigger.click();
  await searchModels.fill("Kimi K3");
  const kimi = modelOptions
    .filter({ hasText: /K3/u })
    .filter({ hasText: /Kimi/u, hasNotText: /256K/u });
  await expect(kimi).toBeEnabled();
  await kimi.click();
  await expect(modelChooser).toBeHidden();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(() => {
    const database = new Database(databasePath, { readonly: true });
    try {
      const row = database.prepare(`
        SELECT active_conversation_id,
               (SELECT model_selection_json FROM conversations
                WHERE id = app_state.active_conversation_id) AS selection,
               (SELECT provider_session_id FROM conversations
                WHERE id = app_state.active_conversation_id) AS provider_session_id,
               (SELECT continuation_identity_json FROM conversations
                WHERE id = app_state.active_conversation_id) AS continuation_identity,
               (SELECT COUNT(*) FROM conversations) AS conversation_count
        FROM app_state
        WHERE id = 1
      `).get() as {
        active_conversation_id: string;
        selection: string;
        provider_session_id: string | null;
        continuation_identity: string | null;
        conversation_count: number;
      };
      const selection = JSON.parse(row.selection) as {
        backendProfileId: string;
        modelId: string;
      };
      return {
        activeId: row.active_conversation_id,
        backendProfileId: selection.backendProfileId,
        modelId: selection.modelId,
        providerSessionId: row.provider_session_id,
        continuationIdentity: row.continuation_identity,
        conversationCount: row.conversation_count,
      };
    } finally {
      database.close();
    }
  }).toEqual({
    activeId: currentConversation.id,
    backendProfileId: "builtin:kimi-code",
    modelId: "k3",
    providerSessionId: null,
    continuationIdentity: null,
    conversationCount: conversationCountBefore,
  });
  const preservedStore = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  try {
    expect(preservedStore.agentTurn(turn.id)).toMatchObject({
      conversationId: currentConversation.id,
      providerSessionAfter: "composer-e2e-session",
      modelSelection: alpha,
      status: "completed",
    });
  } finally {
    preservedStore.close();
  }
  await expect(page.getByText("Keep the authoritative Codex route.", { exact: true }))
    .toBeVisible();
  await expect(modelTrigger).toHaveAccessibleName(
    /Current selection: Claude .* Kimi .* Model K3 \(k3\)/u,
  );

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await resizeWindow(720, 640);
  await modelTrigger.click();
  await expect(modelChooser).toBeVisible();
  const catalogStartedAt = Date.now();
  await searchModels.fill("Catalog Model");
  await expect(modelOptions.first()).toBeVisible();
  expect(Date.now() - catalogStartedAt).toBeLessThan(1_000);
  const mountedCatalogRows = await modelResults.locator(":scope > li").count();
  expect(mountedCatalogRows).toBeGreaterThan(0);
  expect(mountedCatalogRows).toBeLessThanOrEqual(40);
  await expect(modelResults.locator(":scope > :not(li)")).toHaveCount(0);
  const navigatedResult = modelResults.locator(
    ".model-chooser-result.is-navigated .model-chooser-row-option",
  );
  await searchModels.press("End");
  await expect(navigatedResult).toContainText("Catalog Model 0599");
  const lastSelectableCatalogItem = navigatedResult.locator(
    "xpath=ancestor::li",
  );
  await expect(lastSelectableCatalogItem).toHaveAttribute(
    "aria-posinset",
    "600",
  );
  await expect(lastSelectableCatalogItem).toHaveAttribute(
    "aria-setsize",
    "600",
  );
  await expect(searchModels).toBeFocused();
  await searchModels.press("Home");
  await expect(navigatedResult).toContainText("Catalog Model 0000");
  expect(await modelResults.locator(":scope > li").count())
    .toBeLessThanOrEqual(40);
  const catalogAx = await modelResults.ariaSnapshot();
  expect(catalogAx).toContain('- list "Model results"');
  expect(catalogAx).toContain("- listitem:");
  expect(catalogAx).toContain('- button "Add Catalog Model');
  await searchModels.press("Escape");
  await expect(modelChooser).toBeHidden();
  await resizeWindow(1440, 720);
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await workspaceHeader.getByRole("button", { name: "Open workspace tools" }).click();
  }
  expect(rendererErrors).toEqual([]);
});
