import type { UsageDashboardPricing } from "../../shared/contracts";

export interface UsageModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricedModel {
  id: string;
  rates: UsageModelRates;
}

export interface PriceLookup {
  providerId: string;
  model: string;
  alias: string | null;
}

export const USAGE_PRICE_LIST_SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const MAX_PRICE_LIST_MODELS = 20_000;

export interface UsagePricing extends UsageDashboardPricing {
  resolve(lookup: PriceLookup): PricedModel | null;
}

export const UNAVAILABLE_USAGE_PRICING: UsagePricing = {
  status: "unavailable",
  source: USAGE_PRICE_LIST_SOURCE,
  fetchedAt: null,
  modelCount: 0,
  resolve: () => null,
};

const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "moonshot",
  "deepseek",
  "mistral",
  "meta_llama",
]);
const VARIANT_SUFFIX = /\[[^\]]*\]$/u;
const MAX_RATE = 1;

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE
    ? value
    : null;
}

function entryRates(entry: unknown): UsageModelRates | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const input = rate(record.input_cost_per_token);
  const output = rate(record.output_cost_per_token);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: rate(record.cache_read_input_token_cost) ?? input,
    cacheWrite: rate(record.cache_creation_input_token_cost) ?? input,
  };
}

function sameRates(left: UsageModelRates, right: UsageModelRates): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite;
}

function bareName(key: string): string | null {
  if (key.includes("/")) return key.slice(key.lastIndexOf("/") + 1) || null;
  if (key.startsWith("anthropic.")) return key.slice("anthropic.".length) || null;
  return null;
}

export function parsePriceList(document: unknown): Map<string, UsageModelRates> {
  const table = new Map<string, UsageModelRates>();
  if (document === null || typeof document !== "object" || Array.isArray(document)) return table;
  const aliases = new Map<string, { rank: number; rates: UsageModelRates | null }>();
  for (const [rawKey, entry] of Object.entries(document as Record<string, unknown>)) {
    if (table.size >= MAX_PRICE_LIST_MODELS) break;
    const key = rawKey.trim().toLowerCase();
    if (!key || key.length > 200 || key === "sample_spec") continue;
    const rates = entryRates(entry);
    if (!rates) continue;
    table.set(key, rates);
    const bare = bareName(key);
    if (!bare) continue;
    const provider = (entry as Record<string, unknown>).litellm_provider;
    const rank = typeof provider === "string" && FIRST_PARTY_PROVIDERS.has(provider) ? 0 : 1;
    const known = aliases.get(bare);
    if (!known || rank < known.rank) aliases.set(bare, { rank, rates });
    else if (rank === known.rank && known.rates && !sameRates(known.rates, rates)) {
      aliases.set(bare, { rank, rates: null });
    }
  }
  for (const [bare, alias] of aliases) {
    if (alias.rates && !table.has(bare) && table.size < MAX_PRICE_LIST_MODELS) table.set(bare, alias.rates);
  }
  return table;
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9.]+/gu, "-").replaceAll(/^-|-$/gu, "");
}

function candidates({ providerId, model, alias }: PriceLookup): string[] {
  const exact = model.trim().toLowerCase().replace(VARIANT_SUFFIX, "");
  const names = [exact];
  if (exact.includes("/")) names.push(exact.slice(exact.lastIndexOf("/") + 1));
  const named = alias ? slug(alias) : "";
  if (named && /\d/u.test(named)) {
    names.push(named);
    const dashed = named.replaceAll(".", "-");
    names.push(dashed);
    if (providerId === "claude") names.push(`claude-${dashed}`);
  }
  return [...new Set(names.filter(Boolean))];
}

export function resolveModelRates(
  table: ReadonlyMap<string, UsageModelRates>,
  lookup: PriceLookup,
): PricedModel | null {
  for (const id of candidates(lookup)) {
    const rates = table.get(id);
    if (rates) return { id, rates };
  }
  return null;
}
