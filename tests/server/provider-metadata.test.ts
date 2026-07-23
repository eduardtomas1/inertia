import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderModel, ProviderRateLimit } from "../../src/shared/contracts";
import { ProviderManager } from "../../src/server/providers";
import {
  ProviderMetadataCache,
  type PersistedProviderMetadata,
  validateProviderModels,
  validateProviderRateLimits,
} from "../../src/server/provider/metadata";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const codexExecutable = resolve("provider metadata fixture", "codex");
const cursorExecutable = resolve("provider metadata fixture", "cursor-agent");
const openCodeExecutableOne = resolve("provider metadata fixture", "one", "opencode");
const openCodeExecutableTwo = resolve("provider metadata fixture", "two", "opencode");
const workspacePath = resolve("provider metadata fixture", "workspace");

function model(id: string): ProviderModel {
  return {
    id,
    label: id,
    description: `${id} model`,
    isDefault: id === "model-a",
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  };
}

function rateLimit(id: string, usedPercent = 25): ProviderRateLimit {
  return { id, label: id, usedPercent, remainingPercent: 100 - usedPercent, windowMinutes: 300, resetsAt: null };
}

describe("provider metadata cache", () => {
  it("single-flights cold reads, reuses warm process and restart caches, and refreshes expired fields", async () => {
    let now = Date.parse("2026-07-22T10:00:00.000Z");
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let persisted: PersistedProviderMetadata | undefined;
    const persistence = {
      load: () => persisted ? [structuredClone(persisted)] : [],
      save: (metadata: PersistedProviderMetadata) => { persisted = structuredClone(metadata); },
    };
    const reader = async () => {
      reads += 1;
      await gate;
      return { models: [model("model-a")], rateLimits: [rateLimit("five-hour")] };
    };
    const cache = new ProviderMetadataCache({ persistence, read: reader, now: () => now, modelTtlMs: 1_000, rateLimitTtlMs: 1_000 });

    const cold = [
      cache.metadata("codex", codexExecutable, {}, workspacePath),
      cache.metadata("codex", codexExecutable, {}, workspacePath),
      cache.metadata("codex", codexExecutable, {}, workspacePath),
    ];
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(cache.current("codex").metadataState.models.refreshing).toBe(true);
    release();
    await Promise.all(cold);

    await cache.metadata("codex", codexExecutable, {}, workspacePath);
    expect(reads).toBe(1);
    expect(cache.current("codex").metadataState.models).toMatchObject({ freshness: "fresh", provenance: "provider" });

    let restartReads = 0;
    const restarted = new ProviderMetadataCache({
      persistence,
      read: async () => { restartReads += 1; return { models: [model("unexpected")] }; },
      now: () => now,
      modelTtlMs: 1_000,
      rateLimitTtlMs: 1_000,
    });
    await restarted.metadata("codex", codexExecutable, {}, workspacePath);
    expect(restartReads).toBe(0);
    expect(restarted.current("codex").metadataState.models.provenance).toBe("persistent-cache");

    now += 1_001;
    await restarted.metadata("codex", codexExecutable, {}, workspacePath, { fields: ["models"] });
    expect(restartReads).toBe(1);
  });

  it("keeps the last known good field on partial, empty, malformed, and transient responses", async () => {
    let now = Date.parse("2026-07-22T10:00:00.000Z");
    let response = 0;
    let persisted: PersistedProviderMetadata | undefined;
    const cache = new ProviderMetadataCache({
      now: () => now,
      modelTtlMs: 1_000,
      rateLimitTtlMs: 1_000,
      persistence: {
        load: () => persisted ? [structuredClone(persisted)] : [],
        save: (metadata) => { persisted = structuredClone(metadata); },
      },
      read: async () => {
        response += 1;
        if (response === 1) return { models: [model("model-a")], rateLimits: [rateLimit("five-hour", 25)] };
        if (response === 2) return { models: [], rateLimits: [rateLimit("five-hour", 40)] };
        if (response === 3) return { models: [{ id: "" }] as ProviderModel[], rateLimits: "invalid" as unknown as ProviderRateLimit[] };
        throw new Error("provider temporarily unavailable");
      },
    });

    await cache.metadata("codex", codexExecutable, {}, workspacePath);
    now += 1_001;
    await cache.metadata("codex", codexExecutable, {}, workspacePath);
    expect(cache.current("codex")).toMatchObject({
      models: [expect.objectContaining({ id: "model-a" })],
      rateLimits: [expect.objectContaining({ id: "five-hour", usedPercent: 40 })],
      metadataState: { models: { freshness: "stale" }, rateLimits: { freshness: "fresh" } },
    });

    await cache.metadata("codex", codexExecutable, {}, workspacePath, { force: true });
    expect(cache.current("codex").models[0]?.id).toBe("model-a");
    expect(cache.current("codex").rateLimits[0]?.usedPercent).toBe(40);
    expect(cache.current("codex").metadataState).toMatchObject({ models: { freshness: "stale" }, rateLimits: { freshness: "stale" } });

    await cache.metadata("codex", codexExecutable, {}, workspacePath, { force: true });
    expect(cache.current("codex").models[0]?.id).toBe("model-a");
    expect(cache.current("codex").rateLimits[0]?.usedPercent).toBe(40);
    const restarted = new ProviderMetadataCache({
      now: () => now,
      persistence: { load: () => persisted ? [persisted] : [], save: () => undefined },
    });
    expect(restarted.current("codex").metadataState).toMatchObject({
      models: { freshness: "stale", provenance: "persistent-cache" },
      rateLimits: { freshness: "stale", provenance: "persistent-cache" },
    });
  });

  it("bounds untrusted inventories, merges sparse rate updates, and never probes Cursor outside an ACP session", async () => {
    const models = validateProviderModels(Array.from({ length: 150 }, (_, index) => ({
      ...model(`model-${index}`),
      label: "x".repeat(500),
    })));
    const limits = validateProviderRateLimits(Array.from({ length: 30 }, (_, index) => ({
      ...rateLimit(`limit-${index}`, index * 20),
      label: "y".repeat(500),
    })));
    expect(models).toHaveLength(128);
    expect(models[0]?.label).toHaveLength(120);
    expect(limits).toHaveLength(16);
    expect(limits.at(-1)).toMatchObject({ usedPercent: 100, remainingPercent: 0 });
    expect(validateProviderRateLimits([
      rateLimit("nan", Number.NaN),
      rateLimit("infinite", Number.POSITIVE_INFINITY),
      rateLimit("overflow", 130),
      { ...rateLimit("underflow", -20), remainingPercent: -999, resetsAt: "2030-02-30T00:00:00.000Z" },
    ])).toEqual([
      expect.objectContaining({ id: "overflow", usedPercent: 100, remainingPercent: 0 }),
      expect.objectContaining({ id: "underflow", usedPercent: 0, remainingPercent: 100, resetsAt: null }),
    ]);

    let reads = 0;
    const cache = new ProviderMetadataCache({ read: async () => { reads += 1; return {}; } });
    cache.learn("codex", codexExecutable, { rateLimits: [rateLimit("five-hour"), rateLimit("weekly")] }, "provider");
    cache.learn("codex", codexExecutable, { rateLimits: [rateLimit("five-hour", 70)] }, "provider", { merge: true });
    expect(cache.current("codex").rateLimits).toEqual([
      expect.objectContaining({ id: "five-hour", usedPercent: 70 }),
      expect.objectContaining({ id: "weekly" }),
    ]);
    await cache.metadata("cursor", cursorExecutable, {}, workspacePath, { force: true });
    expect(reads).toBe(0);
    expect(cache.current("cursor").metadataState.rateLimits.freshness).toBe("unavailable");
  });

  it("invalidates on executable changes", async () => {
    let reads = 0;
    const cache = new ProviderMetadataCache({ read: async () => ({ models: [model(`model-${++reads}`)] }) });
    await cache.metadata("opencode", openCodeExecutableOne, {}, workspacePath);
    await cache.metadata("opencode", openCodeExecutableOne, {}, workspacePath);
    await cache.metadata("opencode", openCodeExecutableTwo, {}, workspacePath);
    expect(reads).toBe(2);
    expect(cache.current("opencode").models[0]?.id).toBe("model-2");
  });

  it("discards an in-flight response when provider correlation changes", async () => {
    const reads: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new ProviderMetadataCache({
      read: async (_providerId, executable) => {
        reads.push(executable);
        if (executable === openCodeExecutableOne) await gate;
        return { models: [model(executable === openCodeExecutableOne ? "old-model" : "new-model")] };
      },
    });
    const oldRead = cache.metadata("opencode", openCodeExecutableOne, {}, workspacePath);
    await Promise.resolve();
    const newRead = cache.metadata("opencode", openCodeExecutableTwo, {}, workspacePath);
    release();
    await Promise.all([oldRead, newRead]);

    expect(reads).toEqual([openCodeExecutableOne, openCodeExecutableTwo]);
    expect(cache.current("opencode").models).toEqual([expect.objectContaining({ id: "new-model" })]);
  });

  it("revalidates persisted metadata against version and authentication after restart", () => {
    let persisted: PersistedProviderMetadata | undefined;
    const persistence = {
      load: () => persisted ? [structuredClone(persisted)] : [],
      save: (metadata: PersistedProviderMetadata) => { persisted = structuredClone(metadata); },
    };
    const cache = new ProviderMetadataCache({ persistence });
    cache.correlate("codex", { executable: codexExecutable, version: "1.0.0", authState: "authenticated" });
    cache.learn("codex", codexExecutable, { models: [model("model-a")] }, "provider");

    const restarted = new ProviderMetadataCache({ persistence });
    expect(restarted.current("codex").metadataState.models.freshness).toBe("fresh");
    restarted.correlate("codex", { executable: codexExecutable, version: "2.0.0", authState: "unauthenticated" });
    expect(restarted.current("codex")).toMatchObject({
      models: [expect.objectContaining({ id: "model-a" })],
      metadataState: { models: { freshness: "stale", provenance: "persistent-cache" } },
    });
  });

  it("invalidates persisted metadata when previously unknown correlation becomes known", () => {
    let persisted: PersistedProviderMetadata | undefined;
    const persistence = {
      load: () => persisted ? [structuredClone(persisted)] : [],
      save: (metadata: PersistedProviderMetadata) => { persisted = structuredClone(metadata); },
    };
    const cache = new ProviderMetadataCache({ persistence });
    cache.correlate("codex", { executable: codexExecutable, version: null, authState: "unknown" });
    cache.learn("codex", codexExecutable, { models: [model("model-a")], rateLimits: [rateLimit("five-hour")] }, "provider");

    const restarted = new ProviderMetadataCache({ persistence });
    expect(restarted.current("codex").metadataState.models.freshness).toBe("fresh");
    restarted.correlate("codex", { executable: codexExecutable, version: "1.0.0", authState: "authenticated" });
    expect(restarted.current("codex").metadataState).toMatchObject({
      models: { freshness: "stale", provenance: "persistent-cache" },
      rateLimits: { freshness: "stale", provenance: "persistent-cache" },
    });
  });
});

describe.sequential("provider metadata discovery invalidation", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("marks cached metadata stale when provider authentication changes", async () => {
    const root = portableFixtureRoot("metadata auth");
    roots.push(root);
    const marker = join(root, "authenticated");
    const command = portableNodeExecutable(root, "codex");
    writeFileSync(marker, "yes");
    writeNodeSubcommand(root, "login", `
const fs = require("node:fs");
if (fs.readFileSync(${JSON.stringify(marker)}, "utf8").trim() === "yes") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
console.error("Not logged in");
process.exit(1);
`);
    writeNodeSubcommand(root, "app-server", `console.log("codex app-server - Run the app server");`);
    const cache = new ProviderMetadataCache({ read: async () => ({ models: [model("model-a")] }) });
    const manager = new ProviderManager({ commands: { codex: command }, metadataCache: cache });

    await manager.detect("codex", { cwd: root });
    await manager.metadata("codex", root);
    expect(manager.cachedMetadata("codex").metadataState.models.freshness).toBe("fresh");
    writeFileSync(marker, "no");
    await manager.detect("codex", { cwd: root });
    expect(manager.cachedMetadata("codex").metadataState.models.freshness).toBe("stale");
  });
});
