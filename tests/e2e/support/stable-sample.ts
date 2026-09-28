import { expect, type Locator, type Page } from "@playwright/test";

const STABLE_SAMPLE_INTERVAL_MS = 100;
const STABLE_SAMPLE_COUNT = 3;

export interface StableSampleOptions<T> {
  accept?: (sample: T) => boolean;
  timeout?: number;
}

export async function waitForStableSample<T>(
  read: () => Promise<T>,
  { accept = () => true, timeout }: StableSampleOptions<T> = {},
): Promise<T> {
  let latest: T | undefined;
  let previous: string | undefined;
  let matching = 0;
  await expect.poll(async () => {
    latest = await read();
    const serialized = JSON.stringify(latest);
    matching = accept(latest)
      ? serialized === previous ? matching + 1 : 1
      : 0;
    previous = serialized;
    return matching;
  }, {
    intervals: [STABLE_SAMPLE_INTERVAL_MS],
    ...(timeout === undefined ? {} : { timeout }),
  }).toBeGreaterThanOrEqual(STABLE_SAMPLE_COUNT);
  return latest as T;
}

export interface NativeContentSize {
  width: number;
  height: number;
  zoomFactor: number;
}

export async function waitForViewportToMatchWindow(
  page: Page,
  readContentSize: () => Promise<NativeContentSize>,
): Promise<void> {
  await waitForStableSample(async () => {
    const content = await readContentSize();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    return { content, viewport };
  }, {
    accept: ({ content, viewport }) =>
      Math.abs(viewport.width * content.zoomFactor - content.width)
        <= Math.ceil(content.zoomFactor)
      && Math.abs(viewport.height * content.zoomFactor - content.height)
        <= Math.ceil(content.zoomFactor),
  });
}

export async function waitForTranscriptSettled(transcript: Locator): Promise<void> {
  await waitForStableSample(() => transcript.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return {
      scrollTop: Math.round(element.scrollTop),
      scrollHeight: element.scrollHeight,
      rows: [...element.querySelectorAll<HTMLElement>(".response-virtual-item")]
        .map((row) => Math.round(row.getBoundingClientRect().top - viewport.top)),
    };
  }));
}

export async function elapseObservationWindow(
  page: Page,
  durationMs: number,
): Promise<void> {
  await page.waitForTimeout(durationMs);
}
