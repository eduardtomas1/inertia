import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import bundledPriceList from "./bundled-price-list.json" with { type: "json" };
import {
  MAX_PRICE_LIST_MODELS,
  parsePriceList,
  resolveModelRates,
  USAGE_PRICE_LIST_SOURCE,
  type UsageModelRates,
  type UsagePricing,
} from "./price-list";

export const USAGE_PRICE_LIST_TTL_MS = 24 * 60 * 60 * 1_000;
export const USAGE_PRICE_LIST_RETRY_MS = 60 * 1_000;
export const USAGE_PRICE_LIST_TEST_URL_ENVIRONMENT_KEY = "INERTIA_TEST_USAGE_PRICE_LIST_URL";
const FETCH_TIMEOUT_MS = 10_000;
const EMPTY_LIST_WAIT_MS = 4_000;
const MINIMUM_DOWNLOADED_MODELS = 50;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export interface UsagePriceListOptions {
  cachePath: string;
  signal: AbortSignal;
  url?: string | null;
  bundled?: { fetchedAt: number; rates: ReadonlyMap<string, UsageModelRates> } | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export function usagePriceListUrl(environment: NodeJS.ProcessEnv): string | null {
  if (environment.NODE_ENV !== "test") return USAGE_PRICE_LIST_SOURCE;
  const override = environment[USAGE_PRICE_LIST_TEST_URL_ENVIRONMENT_KEY] ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._/-]*$/u.test(override) ? override : null;
}

async function boundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The price list request failed.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_DOCUMENT_BYTES) throw new Error("The price list is too large.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cachedTable(value: unknown): { fetchedAt: number; rates: Map<string, UsageModelRates> } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const models = record.models;
  const fetchedAt = typeof record.fetchedAt === "string" ? Date.parse(record.fetchedAt) : record.fetchedAt;
  if (
    typeof fetchedAt !== "number"
    || !Number.isFinite(fetchedAt)
    || models === null
    || typeof models !== "object"
    || Array.isArray(models)
  ) return null;
  const rates = new Map<string, UsageModelRates>();
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (rates.size >= MAX_PRICE_LIST_MODELS) break;
    if (
      !Array.isArray(entry)
      || entry.length !== 4
      || !entry.every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0)
    ) continue;
    const [input, output, cacheRead, cacheWrite] = entry as [number, number, number, number];
    rates.set(id, { input, output, cacheRead, cacheWrite });
  }
  return rates.size > 0 ? { fetchedAt, rates } : null;
}

const BUNDLED = cachedTable(bundledPriceList);

export class UsagePriceList {
  private rates: ReadonlyMap<string, UsageModelRates>;
  private fetchedAt: number | null;
  private readonly floor: ReadonlyMap<string, UsageModelRates>;
  private readonly minimumModels: number;
  private lastAttemptAt: number | null = null;
  private loaded: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly url: string | null;

  constructor(private readonly options: UsagePriceListOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.url = options.url === undefined ? USAGE_PRICE_LIST_SOURCE : options.url;
    const ownSource = this.url === null || this.url === USAGE_PRICE_LIST_SOURCE;
    const bundled = options.bundled === undefined ? (ownSource ? BUNDLED : null) : options.bundled;
    this.floor = bundled?.rates ?? new Map();
    this.minimumModels = ownSource ? MINIMUM_DOWNLOADED_MODELS : 1;
    this.rates = this.floor;
    this.fetchedAt = bundled?.fetchedAt ?? null;
  }

  pricing(): UsagePricing {
    const rates = this.rates;
    const fresh = this.fetchedAt !== null && this.now() - this.fetchedAt < USAGE_PRICE_LIST_TTL_MS;
    return {
      status: rates.size === 0 ? "unavailable" : fresh ? "fresh" : "cached",
      source: USAGE_PRICE_LIST_SOURCE,
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
      modelCount: rates.size,
      resolve: (lookup) => resolveModelRates(rates, lookup),
    };
  }

  async current(): Promise<UsagePricing> {
    this.loaded ??= this.load();
    await this.loaded;
    const due = this.fetchedAt === null || this.now() - this.fetchedAt >= USAGE_PRICE_LIST_TTL_MS;
    const retryAllowed = this.lastAttemptAt === null
      || this.now() - this.lastAttemptAt >= USAGE_PRICE_LIST_RETRY_MS;
    if (this.url && due && retryAllowed && !this.options.signal.aborted) {
      this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    }
    if (this.rates.size === 0 && this.refreshing) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.refreshing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, EMPTY_LIST_WAIT_MS);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.pricing();
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.options.cachePath, "utf8");
      if (text.length > MAX_CACHE_BYTES) return;
      const cached = cachedTable(JSON.parse(text));
      if (
        !cached
        || cached.rates.size < this.minimumModels
        || cached.fetchedAt > this.now()
        || cached.fetchedAt <= (this.fetchedAt ?? -Infinity)
      ) return;
      this.rates = new Map([...this.floor, ...cached.rates]);
      this.fetchedAt = cached.fetchedAt;
    } catch {
      return;
    }
  }

  private async refresh(): Promise<void> {
    if (!this.url) return;
    this.lastAttemptAt = this.now();
    try {
      const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
      const response = await this.fetcher(this.url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { Accept: "application/json" },
      });
      const rates = parsePriceList(JSON.parse(await boundedText(response)));
      if (rates.size < this.minimumModels) return;
      this.rates = new Map([...this.floor, ...rates]);
      this.fetchedAt = this.now();
      await this.persist(rates);
    } catch {
      return;
    }
  }

  private async persist(downloaded: ReadonlyMap<string, UsageModelRates>): Promise<void> {
    const models: Record<string, [number, number, number, number]> = {};
    for (const [id, rates] of downloaded) {
      models[id] = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];
    }
    const temporary = `${this.options.cachePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.options.cachePath), { recursive: true });
      await writeFile(temporary, JSON.stringify({ fetchedAt: this.fetchedAt, models }), { mode: 0o600 });
      await rename(temporary, this.options.cachePath);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
