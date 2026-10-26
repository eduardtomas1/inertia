export const FRESH_REQUEST_WINDOW_MS = 1_500;
export const COMPOSER_SENT_MS = 420;

interface SentRequest {
  content: string;
  sentAt: number;
}

let sentRequests: SentRequest[] = [];
const composerTimers = new WeakMap<HTMLElement, number>();

function liveRequests(now: number): SentRequest[] {
  return sentRequests.filter(({ sentAt }) => now - sentAt >= 0 && now - sentAt < FRESH_REQUEST_WINDOW_MS);
}

export function noteRequestSent(content: string, now = Date.now()): void {
  const normalized = content.trim();
  if (!normalized) return;
  sentRequests = [...liveRequests(now), { content: normalized, sentAt: now }];
}

export function isFreshRequest(content: string, now = Date.now()): boolean {
  const normalized = content.trim();
  return normalized !== "" && liveRequests(now).some((request) => request.content === normalized);
}

export function claimFreshRequest(content: string, now = Date.now()): boolean {
  const normalized = content.trim();
  const live = liveRequests(now);
  const index = live.findIndex((request) => request.content === normalized);
  sentRequests = index < 0 ? live : live.filter((_, candidate) => candidate !== index);
  return index >= 0;
}

export function resetSentRequests(): void {
  sentRequests = [];
}

export function markComposerSent(region: HTMLElement | null): void {
  const composer = region?.querySelector<HTMLElement>(".composer");
  if (!composer) return;
  const previous = composerTimers.get(composer);
  if (previous !== undefined) window.clearTimeout(previous);
  composer.removeAttribute("data-just-sent");
  void composer.offsetWidth;
  composer.setAttribute("data-just-sent", "");
  composerTimers.set(composer, window.setTimeout(() => {
    composerTimers.delete(composer);
    composer.removeAttribute("data-just-sent");
  }, COMPOSER_SENT_MS));
}
