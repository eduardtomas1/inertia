import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePriceList, resolveModelRates, USAGE_PRICE_LIST_SOURCE } from "../../src/server/usage/price-list";
import {
  UsagePriceList,
  usagePriceListUrl,
  USAGE_PRICE_LIST_TTL_MS,
} from "../../src/server/usage/price-list-service";

const document = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  "claude-opus-5-5": { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002, cache_read_input_token_cost: 0.0000002, cache_creation_input_token_cost: 0.000005, litellm_provider: "anthropic" },
  "gpt-6.1-sol": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000001, litellm_provider: "openai" },
  "azure/eu/gpt-6.1-sol": { input_cost_per_token: 0.0000024, output_cost_per_token: 0.000012, litellm_provider: "azure" },
  "gemini/gemini-3.8-flash": { input_cost_per_token: 0.00000075, output_cost_per_token: 0.00000375, litellm_provider: "gemini" },
  "vertex_ai/gemini-3.8-flash": { input_cost_per_token: 0.0000009, output_cost_per_token: 0.000004, litellm_provider: "vertex_ai" },
  "anthropic.claude-fable-5-1": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00005, litellm_provider: "bedrock_converse" },
  "azure_ai/claude-fable-5-1": { input_cost_per_token: 0.000011, output_cost_per_token: 0.000055, litellm_provider: "azure_ai" },
  "embedding-only": { input_cost_per_token: 0.0000001, litellm_provider: "openai" },
  "broken": { input_cost_per_token: "0.1", output_cost_per_token: Number.NaN },
};

describe("usage price list", () => {
  it("keeps models with an input and an output rate and defaults cache rates to the input rate", () => {
    const table = parsePriceList(document);
    expect(table.get("claude-opus-5-5")).toEqual({ input: 0.000004, output: 0.00002, cacheRead: 0.0000002, cacheWrite: 0.000005 });
    expect(table.get("gpt-6.1-sol")).toEqual({ input: 0.000002, output: 0.00001, cacheRead: 0.0000001, cacheWrite: 0.000002 });
    expect(table.has("sample_spec")).toBe(false);
    expect(table.has("embedding-only")).toBe(false);
    expect(table.has("broken")).toBe(false);
    expect(parsePriceList(null).size).toBe(0);
    expect(parsePriceList([document]).size).toBe(0);
  });

  it("adds a bare name only when it is unambiguous, preferring the model's own provider", () => {
    const table = parsePriceList(document);
    expect(table.get("gpt-6.1-sol")?.input).toBe(0.000002);
    expect(table.get("gemini-3.8-flash")?.input).toBe(0.00000075);
    expect(table.has("claude-fable-5-1")).toBe(false);
  });

  it("resolves recorded model ids without guessing a version", () => {
    const table = parsePriceList(document);
    const resolve = (providerId: string, model: string, alias: string | null = null) =>
      resolveModelRates(table, { providerId, model, alias })?.id ?? null;
    expect(resolve("codex", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(resolve("codex", "GPT-6.1-Sol")).toBe("gpt-6.1-sol");
    expect(resolve("antigravity", "gemini-3.8-flash-high", "Gemini 3.8 Flash (High)")).toBe("gemini-3.8-flash");
    expect(resolve("claude", "opus", "Opus 5.5")).toBe("claude-opus-5-5");
    expect(resolve("claude", "opus[1m]", "Opus (1M context)")).toBeNull();
    expect(resolve("claude", "opus", "Opus")).toBeNull();
    expect(resolve("claude", "opus", null)).toBeNull();
    expect(resolve("opencode", "opencode-go/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(resolve("codex", "gpt-unknown-preview", "GPT Unknown")).toBeNull();
  });
});

describe("usage price list service", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
  async function cachePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "inertia-price-list-"));
    directories.push(directory);
    return join(directory, "usage-price-list.json");
  }
  const answer = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

  it("downloads the list once, stores a compact copy and serves it from disk after a restart", async () => {
    const path = await cachePath();
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    const fetcher = answer(document);
    const first = new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: fetcher, now: () => now });
    expect(first.pricing()).toMatchObject({ status: "unavailable", modelCount: 0, fetchedAt: null, source: USAGE_PRICE_LIST_SOURCE });
    const pricing = await first.ensure(5_000);
    expect(pricing).toMatchObject({ status: "fresh", fetchedAt: "2026-11-11T10:00:00.000Z" });
    expect(pricing.resolve({ providerId: "codex", model: "gpt-6.1-sol", alias: null })?.rates.output).toBe(0.00001);
    await first.ensure(5_000);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(USAGE_PRICE_LIST_SOURCE, expect.objectContaining({ method: "GET", redirect: "error" }));
    const stored = JSON.parse(await readFile(path, "utf8")) as { models: Record<string, number[]> };
    expect(stored.models["claude-opus-5-5"]).toEqual([0.000004, 0.00002, 0.0000002, 0.000005]);

    now += 60 * 60 * 1_000;
    const offline = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const restarted = new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: offline, now: () => now });
    expect(await restarted.ensure(5_000)).toMatchObject({ status: "fresh", modelCount: pricing.modelCount });
    expect(offline).not.toHaveBeenCalled();
  });

  it("keeps serving an old list as cached while a refresh fails, and retries no more than once a minute", async () => {
    const path = await cachePath();
    let now = Date.parse("2026-11-11T10:00:00.000Z");
    await new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: answer(document), now: () => now }).ensure(5_000);
    now += USAGE_PRICE_LIST_TTL_MS + 1;
    const failing = answer({}, 503);
    const list = new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: failing, now: () => now });
    expect(await list.ensure(5_000)).toMatchObject({ status: "cached", fetchedAt: "2026-11-11T10:00:00.000Z" });
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    await list.ensure(5_000);
    expect(failing).toHaveBeenCalledOnce();
    now += 61_000;
    await list.ensure(5_000);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  });

  it("does not wait longer than asked for the first download and rejects a list without prices", async () => {
    const slow = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const list = new UsagePriceList({ cachePath: await cachePath(), signal: new AbortController().signal, fetch: slow });
    const started = Date.now();
    expect(await list.ensure(50)).toMatchObject({ status: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
    const empty = new UsagePriceList({ cachePath: await cachePath(), signal: new AbortController().signal, fetch: answer({ sample_spec: {} }) });
    expect(await empty.ensure(5_000)).toMatchObject({ status: "unavailable", modelCount: 0 });
  });

  it("ignores a damaged or future-dated cache file and never downloads when disabled", async () => {
    const path = await cachePath();
    await writeFile(path, "{not json");
    const fetcher = answer(document);
    const disabled = new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: fetcher, url: null });
    expect(await disabled.ensure(5_000)).toMatchObject({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now() + 86_400_000, models: { "gpt-6.1-sol": [1, 1, 1, 1] } }));
    const future = new UsagePriceList({ cachePath: path, signal: new AbortController().signal, fetch: fetcher, url: null });
    expect(await future.ensure(5_000)).toMatchObject({ status: "unavailable" });
  });

  it("uses the public list outside tests and only a loopback fixture inside them", () => {
    expect(usagePriceListUrl({ NODE_ENV: "production" })).toBe(USAGE_PRICE_LIST_SOURCE);
    expect(usagePriceListUrl({ NODE_ENV: "production", INERTIA_TEST_USAGE_PRICE_LIST_URL: "http://127.0.0.1:9/prices.json" })).toBe(USAGE_PRICE_LIST_SOURCE);
    expect(usagePriceListUrl({ NODE_ENV: "test" })).toBeNull();
    expect(usagePriceListUrl({ NODE_ENV: "test", INERTIA_TEST_USAGE_PRICE_LIST_URL: "off" })).toBeNull();
    expect(usagePriceListUrl({ NODE_ENV: "test", INERTIA_TEST_USAGE_PRICE_LIST_URL: "https://example.test/prices.json" })).toBeNull();
    expect(usagePriceListUrl({ NODE_ENV: "test", INERTIA_TEST_USAGE_PRICE_LIST_URL: "http://127.0.0.1:43111/prices.json" })).toBe("http://127.0.0.1:43111/prices.json");
  });
});
