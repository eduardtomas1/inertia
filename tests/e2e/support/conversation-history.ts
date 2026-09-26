import { expect, type Page } from "@playwright/test";

/** Load the seeded long-history fixture through its actual paging controls. */
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
  let loadedPages = 0;
  for (; loadedPages < 10 && await loadedCount() < expectedCount; loadedPages++) {
    const before = await loadedCount();
    await earlier.scrollIntoViewIfNeeded();
    await earlier.click();
    await expect.poll(loadedCount).toBeGreaterThan(before);
  }
  await expect.poll(loadedCount).toBe(expectedCount);
  await expect(earlier).toHaveCount(0);
  if (loadedPages > 0) {
    // Page prepends intentionally enter reader mode. Restore the fixtures'
    // original follow-latest baseline before measuring geometry or idle work.
    const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(latest).toBeHidden();
    await expect.poll(() => transcript.evaluate((element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(120);
  }
}
