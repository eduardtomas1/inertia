import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePriceList, resolveModelRates, USAGE_PRICE_LIST_SOURCE } from "../../src/server/usage/price-list";
import { UsagePriceList, usagePriceListUrl } from "../../src/server/usage/price-list-service";

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
  const signal = (): AbortSignal => new AbortController().signal;

  it("prices from the list shipped with the build at once, offline and while a download hangs", async () => {
    const hanging = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const list = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: hanging });
    const started = Date.now();
    const pricing = await list.current();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pricing.status).not.toBe("unavailable");
    expect(pricing.modelCount).toBeGreaterThan(100);
    expect(Date.parse(pricing.fetchedAt ?? "")).toBeLessThan(Date.now());
    expect(pricing.resolve({ providerId: "claude", model: "opus", alias: "Opus 5.5" })?.id).toBe("claude-opus-5-5");
    expect(pricing.resolve({ providerId: "codex", model: "gpt-6.1-sol", alias: null })?.rates.output).toBeGreaterThan(0);
    const offline = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), url: null });
    expect((await offline.current()).modelCount).toBe(pricing.modelCount);
  });

  it("replaces the shipped list with a download, stores a compact copy and serves it after a restart", async () => {
    const path = await cachePath();
    let now = Date.parse("2030-01-01T10:00:00.000Z");
    const fetcher = answer(document);
    const first = new UsagePriceList({ cachePath: path, signal: signal(), fetch: fetcher, now: () => now });
    expect((await first.current()).status).toBe("cached");
    await vi.waitFor(() => expect(first.pricing()).toMatchObject({ status: "fresh", fetchedAt: "2030-01-01T10:00:00.000Z", source: USAGE_PRICE_LIST_SOURCE }));
    expect(first.pricing().resolve({ providerId: "codex", model: "gpt-6.1-sol", alias: null })?.rates.output).toBe(0.00001);
    await first.current();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(USAGE_PRICE_LIST_SOURCE, expect.objectContaining({ method: "GET", redirect: "error" }));
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(path, "utf8")) as { models: Record<string, number[]> };
      expect(stored.models["claude-opus-5-5"]).toEqual([0.000004, 0.00002, 0.0000002, 0.000005]);
    });

    now += 60 * 60 * 1_000;
    const offline = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const restarted = new UsagePriceList({ cachePath: path, signal: signal(), fetch: offline, now: () => now });
    expect(await restarted.current()).toMatchObject({ status: "fresh", modelCount: first.pricing().modelCount });
    expect(offline).not.toHaveBeenCalled();
  });

  it("keeps the list it has while a refresh fails, and retries no more than once a minute", async () => {
    let now = Date.parse("2030-01-01T10:00:00.000Z");
    const failing = answer({}, 503);
    const list = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: failing, now: () => now });
    const shipped = (await list.current()).modelCount;
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    expect(await list.current()).toMatchObject({ status: "cached", modelCount: shipped });
    expect(failing).toHaveBeenCalledOnce();
    now += 61_000;
    await list.current();
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
    const empty = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: answer({ sample_spec: {} }), now: () => now });
    await empty.current();
    await vi.waitFor(() => expect(empty.pricing()).toMatchObject({ status: "cached", modelCount: shipped }));
  });

  it("waits for a first download only when it has no list at all", async () => {
    const list = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: answer(document), bundled: null });
    expect(list.pricing()).toMatchObject({ status: "unavailable", modelCount: 0, fetchedAt: null });
    expect(await list.current()).toMatchObject({ status: "fresh" });
    const fixture = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: answer(document), url: "http://127.0.0.1:43111/prices.json" });
    expect(fixture.pricing().modelCount).toBe(0);
    expect((await fixture.current()).resolve({ providerId: "codex", model: "gpt-6.1-sol", alias: null })?.id).toBe("gpt-6.1-sol");
    const disabled = new UsagePriceList({ cachePath: await cachePath(), signal: signal(), fetch: answer(document), url: null, bundled: null });
    expect(await disabled.current()).toMatchObject({ status: "unavailable" });
  });

  it("ignores a damaged, future-dated or older stored copy", async () => {
    const path = await cachePath();
    const fetcher = answer(document);
    await writeFile(path, "{not json");
    const damaged = new UsagePriceList({ cachePath: path, signal: signal(), fetch: fetcher, url: null });
    const shipped = (await damaged.current()).modelCount;
    expect(shipped).toBeGreaterThan(100);
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now() + 86_400_000, models: { "gpt-6.1-sol": [1, 1, 1, 1] } }));
    expect((await new UsagePriceList({ cachePath: path, signal: signal(), url: null }).current()).modelCount).toBe(shipped);
    await writeFile(path, JSON.stringify({ fetchedAt: Date.parse("2020-01-01T00:00:00.000Z"), models: { "gpt-6.1-sol": [1, 1, 1, 1] } }));
    expect((await new UsagePriceList({ cachePath: path, signal: signal(), url: null }).current()).modelCount).toBe(shipped);
    expect(fetcher).not.toHaveBeenCalled();
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
