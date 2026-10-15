import { expect, type Page } from "@playwright/test";

export async function readFromTranscriptStart(page: Page): Promise<void> {
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
  await expect(async () => {
    await transcript.press("Home");
    await expect(latest).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

export async function loadSeededConversationTurns(page: Page, expectedCount: number): Promise<void> {
  const transcript = page.getByLabel("Thread transcript", { exact: true });
  const loadedCount = () => transcript.evaluate((element) => {
    const feed = element.querySelector('[role="feed"][aria-label$=" conversation turns"]');
    return feed
      ? Number(/^(\d+) conversation turns$/u.exec(feed.getAttribute("aria-label") ?? "")?.[1] ?? 0)
      : element.querySelectorAll(".response-static-item").length;
  });
  await expect.poll(loadedCount).toBeGreaterThan(0);
  const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
  const pagesMissing = await loadedCount() < expectedCount;
  if (pagesMissing) await readFromTranscriptStart(page);
  for (let loadedPages = 0; loadedPages < 10; loadedPages++) {
    const before = await loadedCount();
    if (before >= expectedCount) break;
    await expect.poll(async () => {
      const count = await loadedCount();
      if (count === before && await earlier.isVisible()) await earlier.click({ timeout: 1_000 }).catch(() => undefined);
      return count;
    }).toBeGreaterThan(before);
  }
  await expect.poll(loadedCount).toBe(expectedCount);
  await expect(earlier).toHaveCount(0);
  if (pagesMissing) {
    const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(latest).toBeHidden();
    await expect.poll(() => transcript.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(120);
  }
}
