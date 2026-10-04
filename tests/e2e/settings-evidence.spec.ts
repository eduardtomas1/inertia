// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const evidenceDirectory = process.env.INERTIA_SETTINGS_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_SETTINGS_EVIDENCE_DIR)
  : null;

const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "settings-evidence-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [
      {
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Latest agentic coding model for complex engineering work.",
        isDefault: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" },
          { reasoningEffort: "high", description: "Deep reasoning" }
        ]
      },
      {
        model: "gpt-5.2-codex-mini",
        displayName: "GPT-5.2 Codex Mini",
        description: "Fast, efficient coding model for everyday tasks.",
        inputModalities: ["text"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced reasoning" }
        ]
      }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
});
`;

const claudeAuthSource = `
if (process.argv[2] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
`;

const LONG_PROJECT_NAME = "customer-onboarding-experience-redesign-with-a-deliberately-long-project-name";

const PROJECT_NAMES = [
  "api-gateway", "billing-service", "checkout-web", "design-system", "docs-site",
  "edge-workers", "feature-flags", "growth-experiments", "identity-provider",
  "infra-terraform", "ios-app", "android-app", "marketing-site", "metrics-pipeline",
  "mobile-shared", "notifications", "onboarding-flows", "payments-core",
  "platform-tools", "search-indexer", "support-console", "web-analytics",
  LONG_PROJECT_NAME,
];

const ARCHIVED_TITLES = [
  "Fix flaky checkout test on CI", "Migrate billing webhooks to v2",
  "Investigate memory growth in the runtime supervisor after long sessions with many attachments and subagents",
  "Add dark mode tokens", "Refactor provider discovery", "Write release notes for 0.9",
  "Audit dependency licences", "Speed up cold start", "Remove legacy settings keys",
  "Prototype keyboard-only navigation", "Trim CI certification tiers", "Repair diff wrap toggle",
  "Investigate Windows path casing", "Bump Electron", "Document Private Connect pairing",
  "Explore worktree setup actions", "Clean stale snapshots", "Review attachment budgets",
];

const DIAGNOSTIC_CODES = [
  "discord.repository-missing",
  "discord.webhook-missing",
  "application.validation-failed",
] as const;

const SIGNED_OUT_CLAUDE_INCIDENTS = 1;

const VIEWPORTS = [
  { theme: "light", size: "wide", width: 1440, height: 920, coverage: "every-state" },
  { theme: "dark", size: "wide", width: 1440, height: 920, coverage: "sections-and-cards" },
  { theme: "dark", size: "narrow", width: 1000, height: 800, coverage: "sections" },
  { theme: "dark", size: "760x600", width: 760, height: 600, coverage: "sections" },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

type Card = readonly [state: string, heading: string | null];

const ARCHIVED_PAGE_FILLER = 8;

const SECTIONS: ReadonlyArray<{
  id: string;
  label: string;
  overview: string;
  select?: string;
  cards?: readonly Card[];
}> = [
  {
    id: "appearance",
    label: "Appearance",
    overview: "theme",
    cards: [["theme", null], ["scale", "interface-scale-heading"], ["working-indicator", "working-indicator-heading"]],
  },
  {
    id: "chats",
    label: "Chats",
    overview: "new-chats",
    cards: [["new-chats", null], ["transcript", "transcript-heading"], ["review-terminal", "source-heading"]],
  },
  {
    id: "notifications",
    label: "Notifications",
    overview: "alerts",
    cards: [["alerts", null], ["sound", "completion-sound-heading"], ["mascot", "desktop-mascot-heading"]],
  },
  { id: "keyboard", label: "Keyboard", overview: "default" },
  { id: "projects", label: "Projects", overview: "all" },
  { id: "agents", label: "Agents", overview: "codex", select: "Configure Codex" },
  {
    id: "devices",
    label: "Devices & integrations",
    overview: "private-connect",
    cards: [["private-connect", null], ["snapshots", "snapshot-capture-heading"], ["discord", "discord-heading"]],
  },
  {
    id: "data",
    label: "Data",
    overview: "storage",
    cards: [["storage", null], ["recovery", "recovery-heading"], ["archived", "archive-heading"], ["defaults", "restore-defaults-heading"]],
  },
  {
    id: "help",
    label: "Help",
    overview: "report-issue",
    cards: [["report-issue", null], ["diagnostics", "diagnostics-heading"], ["support", "support-heading"], ["updates", "application-update-heading"]],
  },
];

function sectionCards(id: string): readonly Card[] {
  return SECTIONS.find((section) => section.id === id)!.cards!;
}

let app!: AppFixture;
let page!: Page;
const capturedNames = new Set<string>();

function settingsNavigation(label: string): Locator {
  return page.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: label, exact: true });
}

function settingsContent(): Locator {
  return page.locator(".settings-content");
}

function sectionLabel(id: string): string {
  return SECTIONS.find((section) => section.id === id)!.label;
}

async function capture(name: string, options: { keepFocus?: boolean } = {}): Promise<void> {
  if (!evidenceDirectory) throw new Error("INERTIA_SETTINGS_EVIDENCE_DIR is not set.");
  if (capturedNames.has(name)) throw new Error(`Evidence image ${name} was captured twice.`);
  capturedNames.add(name);
  await page.mouse.move(0, 0);
  if (!options.keepFocus) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), animations: "disabled" });
}

async function waitForSettledSection(): Promise<void> {
  await expect(settingsContent().locator("[aria-busy='true']")).toHaveCount(0);
  await expect(settingsContent()).not.toContainText(/Loading .*…/u);
  await page.waitForTimeout(300);
}

async function openSection(label: string): Promise<void> {
  await settingsNavigation(label).click();
  await expect(settingsNavigation(label)).toHaveAttribute("aria-current", "page");
  await settingsContent().evaluate((element) => { element.scrollTop = 0; });
  await waitForSettledSection();
}

async function scrollContentTo(top: number, scroller = settingsContent()): Promise<number> {
  const scrollTop = await scroller.evaluate((element, value) => {
    element.scrollTop = value;
    return element.scrollTop;
  }, top);
  await page.waitForTimeout(120);
  return scrollTop;
}

async function capturePages(
  name: (page: number | null) => string,
  { start = 0, end, scroller = settingsContent(), allPages = true }: {
    start?: number;
    end?: number;
    scroller?: Locator;
    allPages?: boolean;
  } = {},
): Promise<void> {
  const { scrollHeight, clientHeight } = await scroller.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  const step = Math.max(200, clientHeight - 48);
  const last = Math.min(end ?? scrollHeight, scrollHeight) - clientHeight;
  const positions: number[] = [];
  for (let top = start; ; top += step) {
    const scrollTop = await scrollContentTo(Math.min(top, Math.max(start, last)), scroller);
    if (positions.includes(scrollTop)) break;
    positions.push(scrollTop);
    if (!allPages || top >= last) break;
  }
  for (const [index, top] of positions.entries()) {
    await scrollContentTo(top, scroller);
    await capture(name(positions.length === 1 ? null : index + 1));
  }
}

function evidenceName(section: string, state: string, viewport: Viewport) {
  return (pageNumber: number | null): string => [
    section,
    state,
    ...(pageNumber === null ? [] : [`p${pageNumber}`]),
    viewport.theme,
    viewport.size,
  ].join("-");
}

async function offsetWithinContent(locator: Locator): Promise<{ top: number; bottom: number }> {
  return locator.evaluate((element) => {
    const scroller = element.closest(".settings-content")!;
    const box = element.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    const top = box.top - frame.top + scroller.scrollTop;
    return { top, bottom: top + box.height };
  });
}

async function cardTop(heading: string | null): Promise<number> {
  if (!heading) return 0;
  const { top } = await offsetWithinContent(settingsContent().locator(`section[aria-labelledby='${heading}']`));
  return Math.max(0, Math.floor(top) - 16);
}

async function captureCards(
  section: string,
  cards: readonly Card[],
  viewport: Viewport,
  allPages: boolean,
): Promise<void> {
  const captured: number[] = [];
  for (const [index, [card, heading]] of cards.entries()) {
    const next = cards[index + 1];
    const end = next ? await cardTop(next[1]) : undefined;
    const scrollTop = await scrollContentTo(await cardTop(heading));
    if (captured.includes(scrollTop)) continue;
    captured.push(scrollTop);
    await capturePages(evidenceName(section, card, viewport), { start: scrollTop, end, allPages });
  }
}

async function captureProjectStates(viewport: Viewport): Promise<void> {
  await openSection(sectionLabel("projects"));
  await capturePages(evidenceName("projects", "all", viewport));
  const chooser = page.getByRole("button", { name: "Choose project" });
  await chooser.click();
  await page.keyboard.type(LONG_PROJECT_NAME.slice(0, 24));
  await page.keyboard.press("Enter");
  await expect(chooser).toContainText(LONG_PROJECT_NAME);
  await waitForSettledSection();
  await capturePages(evidenceName("projects", "project", viewport));

  const addAction = page.getByRole("button", { name: "Add action" });
  await addAction.click();
  const actionForm = page.locator(".project-action-form");
  await expect(actionForm).toBeVisible();
  await scrollContentTo(Math.max(0, Math.floor((await offsetWithinContent(addAction)).top) - 120));
  await capture(evidenceName("projects", "add-action", viewport)(null));
  await actionForm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actionForm).toHaveCount(0);

  const budget = page.getByRole("textbox", { name: "Claude spend limit per turn (USD)" });
  await scrollContentTo(Math.max(0, Math.floor((await offsetWithinContent(budget)).top) - 160));
  await budget.click();
  await page.keyboard.type("12.345");
  await budget.blur();
  await expect(budget).toHaveAttribute("aria-invalid", "true");
  await capture(evidenceName("projects", "spend-limit-invalid", viewport)(null));
  await budget.fill("");
  await expect(budget).not.toHaveAttribute("aria-invalid");
}

async function captureAgentStates(viewport: Viewport): Promise<void> {
  await openSection(sectionLabel("agents"));
  await page.getByRole("button", { name: "Configure Codex" }).click();
  await waitForSettledSection();
  const backends = page.locator(".backend-settings");
  const backendsTop = Math.max(0, Math.floor((await offsetWithinContent(backends)).top) - 16);
  await capturePages(evidenceName("agents", "codex", viewport), { end: backendsTop });
  const details = page.locator(".provider-settings-details > summary");
  await details.click();
  await scrollContentTo(Math.max(0, Math.floor((await offsetWithinContent(details)).top) - 160));
  await capture(evidenceName("agents", "codex-details", viewport)(null));
  await details.click();
  await scrollContentTo(0);

  await page.getByRole("button", { name: "Configure Claude" }).click();
  await waitForSettledSection();
  await capture(evidenceName("agents", "claude-signed-out", viewport)(null));

  await page.getByRole("button", { name: "Configure Cursor" }).click();
  await waitForSettledSection();
  await capture(evidenceName("agents", "cli-missing", viewport)(null));

  await capturePages(evidenceName("agents", "custom-backends", viewport), { start: backendsTop });
  await page.getByRole("button", { name: "New profile" }).click();
  const cancel = page.getByRole("button", { name: "Cancel profile editing" });
  await expect(cancel).toBeVisible();
  await waitForSettledSection();
  await capturePages(evidenceName("agents", "new-profile", viewport), { start: backendsTop });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
  await scrollContentTo(0);
}

async function captureDiscordStates(viewport: Viewport): Promise<void> {
  const repository = page.getByRole("textbox", { name: "Repository URL" });
  await repository.click();
  await page.keyboard.type("not-a-url", { delay: 150 });
  await expect(repository).toHaveValue("not-a-url");
  await repository.blur();
  await expect(repository).toHaveAttribute("aria-invalid", "true");
  await capture(evidenceName("devices", "discord-invalid-url", viewport)(null));
  await repository.fill("https://github.com/eduardtomas1/inertia");
  await repository.blur();
  await expect(repository).not.toHaveAttribute("aria-invalid");
  const webhook = page.getByRole("textbox", { name: "Webhook URL" });
  await webhook.fill("https://discord.com/api/webhooks/evidence/fixture");
  const post = page.getByRole("button", { name: "Post release to Discord…" });
  await post.click();
  const confirm = page.getByRole("group", { name: "Confirm Discord post" });
  await expect(confirm).toBeVisible();
  await confirm.scrollIntoViewIfNeeded();
  await capture(evidenceName("devices", "discord-post-confirm", viewport)(null), { keepFocus: true });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await webhook.fill("");
  await repository.fill("");
  await repository.blur();
  await scrollContentTo(0);
}

async function captureArchivedStates(viewport: Viewport): Promise<void> {
  const filter = page.getByRole("searchbox", { name: "Filter archived chats" });
  await filter.scrollIntoViewIfNeeded();
  await filter.fill("investigate");
  await page.waitForTimeout(200);
  await capture(evidenceName("data", "archived-filter", viewport)(null));
  await filter.fill("");
  const more = page.getByRole("button", { name: /^Show \d+ more$/u });
  await more.scrollIntoViewIfNeeded();
  await more.click();
  await page.waitForTimeout(200);
  await capture(evidenceName("data", "archived-all", viewport)(null), { keepFocus: true });
  await scrollContentTo(0);
}

async function captureDiagnosticStates(viewport: Viewport): Promise<void> {
  const incidents = page.locator(".diagnostics-incident > summary");
  await expect.poll(() => incidents.count())
    .toBeGreaterThanOrEqual(DIAGNOSTIC_CODES.length + SIGNED_OUT_CLAUDE_INCIDENTS);
  await incidents.first().click();
  await page.waitForTimeout(200);
  const { top } = await offsetWithinContent(incidents.first());
  await scrollContentTo(Math.max(0, Math.floor(top) - 120));
  await capture(evidenceName("help", "diagnostics-incident", viewport)(null));
  await incidents.first().click();
  await scrollContentTo(0);
}

async function captureDefaultState(id: string, viewport: Viewport): Promise<void> {
  await openSection(sectionLabel(id));
  await capturePages(evidenceName(id, "default", viewport));
}

async function captureCardSection(id: string, viewport: Viewport): Promise<void> {
  await openSection(sectionLabel(id));
  await captureCards(id, sectionCards(id), viewport, true);
}

async function captureEveryState(viewport: Viewport): Promise<void> {
  for (const id of ["appearance", "chats", "notifications"]) await captureCardSection(id, viewport);
  await captureDefaultState("keyboard", viewport);
  await captureProjectStates(viewport);
  await captureAgentStates(viewport);
  await captureCardSection("devices", viewport);
  await captureDiscordStates(viewport);
  await captureCardSection("data", viewport);
  await captureArchivedStates(viewport);
  await captureCardSection("help", viewport);
  await captureDiagnosticStates(viewport);
}

async function captureSections(viewport: Viewport): Promise<void> {
  for (const section of SECTIONS) {
    await openSection(section.label);
    if (section.select) {
      await page.getByRole("button", { name: section.select }).click();
      await waitForSettledSection();
    }
    if (section.cards && viewport.coverage === "sections-and-cards") {
      await captureCards(section.id, section.cards, viewport, false);
    } else {
      await capture(evidenceName(section.id, section.overview, viewport)(null));
      if (section.id === "help") {
        await scrollContentTo(await cardTop("diagnostics-heading"));
        await capture(evidenceName("help", "diagnostics", viewport)(null));
      }
    }
  }
}

async function captureViewport(viewport: Viewport): Promise<void> {
  await setAppearanceInPlace(app, viewport.theme);
  await app.resizeWindow(viewport.width, viewport.height);
  if (viewport.coverage === "every-state") await captureEveryState(viewport);
  else await captureSections(viewport);
}

async function openPalette(): Promise<Locator> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const search = page.getByRole("combobox", { name: "Search commands, projects, chats, and messages" });
  await expect(search).toBeFocused();
  return search;
}

async function captureEntryAndExit(viewport: Viewport): Promise<void> {
  await setAppearanceInPlace(app, viewport.theme);
  await app.resizeWindow(viewport.width, viewport.height);
  const settings = page.getByRole("main", { name: "Settings" });
  await expect(settings).toHaveCount(0);
  await capture(evidenceName("entry", "chat", viewport)(null));

  const search = await openPalette();
  await search.fill("settings");
  await page.waitForTimeout(300);
  await capture(evidenceName("entry", "palette-settings", viewport)(null), { keepFocus: true });
  await search.fill("theme");
  await page.waitForTimeout(300);
  await capture(evidenceName("entry", "palette-theme", viewport)(null), { keepFocus: true });
  await search.fill("settings");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await expect(settings).toBeVisible();
  await waitForSettledSection();
  await capture(evidenceName("entry", "opened", viewport)(null), { keepFocus: true });

  await openSection(sectionLabel("keyboard"));
  await settingsNavigation(sectionLabel("keyboard")).focus();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.waitForTimeout(300);
  await capture(evidenceName("exit", "escape", viewport)(null), { keepFocus: true });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.waitForTimeout(300);
  await capture(evidenceName("exit", "workspace", viewport)(null), { keepFocus: true });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await waitForSettledSection();
  await capture(evidenceName("exit", "reopened", viewport)(null), { keepFocus: true });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "settings-evidence",
    initialState: "conversation",
    seedAssistantCodeBlock: true,
    codexAppServerSource,
    claudeAuthSource,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const fixture = store.snapshot().conversations
          .find(({ title }) => title === "settings-evidence fixture")!;
        const projectIds: string[] = [];
        for (const name of PROJECT_NAMES) {
          const path = join(testDirectory, "projects", name);
          await mkdir(path, { recursive: true });
          projectIds.push(store.createProject(name, path).id);
        }
        for (const title of [...ARCHIVED_TITLES, ...Array.from({ length: ARCHIVED_PAGE_FILLER }, (_, index) => `Archived follow-up ${index + 1}`)]) {
          const conversation = store.createConversation(projectIds[0], title);
          store.archiveConversation(conversation.id, true);
        }
        store.selectProject(fixture.projectId);
        store.selectConversation(fixture.id);
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
  await page.clock.setFixedTime(new Date("2026-10-03T10:30:00Z"));
});

test.afterAll(async () => {
  await app?.close();
});

test("keeps Settings inside a 760x600 window", async () => {
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
  await settingsNavigation("Appearance").click();
  await expect(settingsNavigation("Appearance")).toHaveAttribute("aria-current", "page");
  await app.resizeWindow(760, 600);
  const titleEdges = new Map<string, number>();
  for (const { label } of SECTIONS) {
    await openSection(label);
    await app.expectNoViewportOverflow();
    await expect(page.locator(".settings-content button button")).toHaveCount(0);
    titleEdges.set(label, await page.locator(".settings-page-title").evaluate((element) => element.getBoundingClientRect().left));
  }
  expect(new Set(titleEdges.values()), JSON.stringify(Object.fromEntries(titleEdges))).toHaveProperty("size", 1);
  expect(app.rendererErrors).toEqual([]);
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toHaveCount(0);
});

test("captures every Settings section for PR evidence", async () => {
  test.skip(!evidenceDirectory, "Set INERTIA_SETTINGS_EVIDENCE_DIR to capture Settings evidence.");
  test.setTimeout(1_800_000);
  await mkdir(evidenceDirectory!, { recursive: true });
  await page.evaluate(async (codes) => {
    for (const code of codes) {
      await window.inertia.reportValidationDiagnostic({ code, correlationId: crypto.randomUUID() });
    }
  }, [...DIAGNOSTIC_CODES]);

  await test.step("entry and exit", () => captureEntryAndExit(VIEWPORTS[0]));
  for (const viewport of VIEWPORTS) {
    await test.step(`${viewport.theme} ${viewport.size}`, () => captureViewport(viewport));
  }
  expect(app.rendererErrors).toEqual([]);
});
