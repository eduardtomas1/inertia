import { expect, test, type Frame, type Locator } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  createAppFixture,
  type AppFixture,
  type RuntimeTestSnapshot,
} from "./support/app-fixture";
import { selectWorkspaceTool } from "./support/workspace-tools";

interface ReaderAnchor {
  id: string;
  offset: number;
}

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "chat-reload-stability",
    initialState: "conversation",
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
        for (let index = 0; index < 90; index += 1) {
          store.createMessage(
            conversation.id,
            `${pane} reconnect row ${index.toString().padStart(2, "0")} — keep this transcript mounted while the runtime restarts.`,
            index % 2 === 0 ? "user" : "assistant",
            [],
            null,
            undefined,
            { activateConversation: false },
          );
        }
      }
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

async function moveIntoHistory(pane: Locator): Promise<ReaderAnchor> {
  const transcript = pane.getByLabel("Thread transcript");
  await transcript.evaluate((element) => {
    element.scrollTop = Math.floor(
      (element.scrollHeight - element.clientHeight) * 0.42,
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(pane.getByRole("button", { name: "Jump to latest" }))
    .toBeVisible();
  await page.waitForTimeout(250);
  const anchor = await pane.evaluate((root) => {
    const viewport = root.querySelector<HTMLElement>(".message-scroll")
      ?.getBoundingClientRect();
    if (!viewport) return null;
    const row = [...root.querySelectorAll<HTMLElement>(
      "[data-response-row-id]",
    )].find((candidate) =>
      candidate.getBoundingClientRect().bottom > viewport.top + 8);
    return row?.dataset.responseRowId
      ? {
          id: row.dataset.responseRowId,
          offset: row.getBoundingClientRect().top - viewport.top,
        }
      : null;
  });
  expect(anchor).not.toBeNull();
  return anchor!;
}

async function currentAnchor(
  pane: Locator,
  id: string,
): Promise<ReaderAnchor | null> {
  return await pane.evaluate((root, rowId) => {
    const viewport = root.querySelector<HTMLElement>(".message-scroll")
      ?.getBoundingClientRect();
    const row = [...root.querySelectorAll<HTMLElement>(
      "[data-response-row-id]",
    )].find((candidate) => candidate.dataset.responseRowId === rowId);
    return row && viewport
      ? {
          id: rowId,
          offset: row.getBoundingClientRect().top - viewport.top,
        }
      : null;
  }, id);
}

test("never replaces mounted chats during a supervised runtime restart", async () => {
  await app.resizeWindow(1440, 920);
  const primaryTitle = "chat-reload-stability fixture";
  const secondaryTitle = "chat-reload-stability companion";
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
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
  const primary = page.getByRole("region", {
    name: `Primary chat: Inertia · ${primaryTitle}`,
  });
  const secondary = page.getByRole("region", {
    name: `Second chat: Companion · ${secondaryTitle}`,
  });
  await expect(split).toBeVisible();
  await primary.getByText("Recovered legacy history", { exact: true }).click();
  await secondary.getByText("Recovered legacy history", { exact: true }).click();
  await expect(primary.getByText("primary reconnect row 89", {
    exact: false,
  })).toBeVisible();
  await expect(secondary.getByText("secondary reconnect row 89", {
    exact: false,
  })).toBeVisible();

  const primaryComposer = primary.getByRole("textbox", { name: "Message" });
  const secondaryComposer = secondary.getByRole("textbox", {
    name: "Message",
  });
  await primaryComposer.fill("Primary draft must survive reconnect");
  await secondaryComposer.fill("Secondary draft must survive reconnect");

  await app.electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, app.attachmentImagePath);
  await primary.getByRole("button", {
    name: "Attach images or documents",
  }).click();
  const attachment = primary.getByRole("button", {
    name: "Preview attachment preview.png",
  });
  await expect(attachment).toBeVisible();

  await primary.getByRole("button", {
    name: `Open tools for ${primaryTitle}`,
  }).click();
  const primaryTools = primary.getByRole("complementary", {
    name: "Workspace tools",
  });
  await selectWorkspaceTool(primaryTools, "Files");
  const sourceDirectory = primaryTools.getByRole("treeitem", {
    name: "src",
    exact: true,
  });
  await expect(sourceDirectory).toBeVisible();
  await sourceDirectory.click();
  await expect(sourceDirectory).toHaveAttribute("aria-expanded", "true");

  const primaryAnchor = await moveIntoHistory(primary);
  const secondaryAnchor = await moveIntoHistory(secondary);
  const marker = await page.evaluate(() => {
    const value = crypto.randomUUID();
    const primaryPane = document.querySelector<HTMLElement>(
      "#primary-conversation-pane",
    );
    const secondaryPane = document.querySelector<HTMLElement>(
      "#secondary-conversation-pane",
    );
    const primaryInput = primaryPane?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    const secondaryInput = secondaryPane?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    const primaryTranscript = primaryPane?.querySelector<HTMLElement>(
      ".message-scroll",
    );
    const secondaryTranscript = secondaryPane?.querySelector<HTMLElement>(
      ".message-scroll",
    );
    const attachmentButton = primaryPane?.querySelector<HTMLElement>(
      'button[aria-label="Preview attachment preview.png"]',
    );
    if (
      !primaryPane
      || !secondaryPane
      || !primaryInput
      || !secondaryInput
      || !primaryTranscript
      || !secondaryTranscript
      || !attachmentButton
    ) {
      throw new Error("The reconnect stability probe could not bind the mounted panes.");
    }
    const failures: string[] = [];
    const sample = (): void => {
      const nodes = {
        primaryPane,
        secondaryPane,
        primaryInput,
        secondaryInput,
        primaryTranscript,
        secondaryTranscript,
        attachmentButton,
      };
      for (const [name, node] of Object.entries(nodes)) {
        if (!node.isConnected && !failures.includes(name)) failures.push(name);
      }
      if (
        primaryTranscript.querySelector(".empty-thread")
        && !failures.includes("primary-empty")
      ) failures.push("primary-empty");
      if (
        secondaryTranscript.querySelector(".empty-thread")
        && !failures.includes("secondary-empty")
      ) failures.push("secondary-empty");
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.getElementById("root")!, {
      childList: true,
      subtree: true,
    });
    Reflect.set(window, "__inertiaReconnectStability", {
      value,
      failures,
      observer,
      sample,
      primaryPane,
      secondaryPane,
      primaryInput,
      secondaryInput,
      attachmentButton,
    });
    return value;
  });

  let mainFrameNavigations = 0;
  const recordNavigation = (frame: Frame): void => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  };
  page.on("framenavigated", recordNavigation);
  const before = await app.runtimeSnapshot();
  const beforeRuntimeGeneration = await page.locator(".app-shell")
    .getAttribute("data-runtime-generation");
  await app.electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      crash: () => RuntimeTestSnapshot;
    } | undefined;
    if (!runtime) throw new Error("The test runtime supervisor is unavailable");
    runtime.crash();
  });

  await expect.poll(async () => {
    const current = await app.runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => {
    const generation = await page.locator(".app-shell")
      .getAttribute("data-runtime-generation");
    return generation && generation !== beforeRuntimeGeneration;
  }, { timeout: 10_000 }).toBe(true);
  await expect(page.locator(".app-shell")).toHaveAttribute(
    "data-connection-status",
    "online",
  );
  await expect(primary.getByText("primary reconnect row 89", {
    exact: false,
  })).toBeVisible();
  await expect(secondary.getByText("secondary reconnect row 89", {
    exact: false,
  })).toBeVisible();

  page.off("framenavigated", recordNavigation);
  expect(mainFrameNavigations).toBe(0);
  const stability = await page.evaluate(() => {
    const probe = Reflect.get(window, "__inertiaReconnectStability") as {
      value: string;
      failures: string[];
      observer: MutationObserver;
      sample: () => void;
      primaryPane: HTMLElement;
      secondaryPane: HTMLElement;
      primaryInput: HTMLTextAreaElement;
      secondaryInput: HTMLTextAreaElement;
      attachmentButton: HTMLElement;
    } | undefined;
    if (!probe) return null;
    probe.sample();
    probe.observer.disconnect();
    return {
      value: probe.value,
      failures: probe.failures,
      samePrimaryPane: probe.primaryPane
        === document.querySelector("#primary-conversation-pane"),
      sameSecondaryPane: probe.secondaryPane
        === document.querySelector("#secondary-conversation-pane"),
      samePrimaryInput: probe.primaryInput
        === document.querySelector(
          '#primary-conversation-pane textarea[aria-label="Message"]',
        ),
      sameSecondaryInput: probe.secondaryInput
        === document.querySelector(
          '#secondary-conversation-pane textarea[aria-label="Message"]',
        ),
      sameAttachment: probe.attachmentButton
        === document.querySelector(
          '#primary-conversation-pane button[aria-label="Preview attachment preview.png"]',
        ),
    };
  });
  expect(stability).toEqual({
    value: marker,
    failures: [],
    samePrimaryPane: true,
    sameSecondaryPane: true,
    samePrimaryInput: true,
    sameSecondaryInput: true,
    sameAttachment: true,
  });
  await expect(primaryComposer).toHaveValue(
    "Primary draft must survive reconnect",
  );
  await expect(secondaryComposer).toHaveValue(
    "Secondary draft must survive reconnect",
  );
  await expect(attachment).toBeVisible();
  await expect(primaryTools).toBeVisible();
  await expect(sourceDirectory).toHaveAttribute("aria-expanded", "true");

  await expect.poll(async () => {
    const anchor = await currentAnchor(primary, primaryAnchor.id);
    return anchor
      ? Math.abs(anchor.offset - primaryAnchor.offset)
      : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(3);
  await expect.poll(async () => {
    const anchor = await currentAnchor(secondary, secondaryAnchor.id);
    return anchor
      ? Math.abs(anchor.offset - secondaryAnchor.offset)
      : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(3);
  expect(app.rendererErrors).toEqual([]);
});
