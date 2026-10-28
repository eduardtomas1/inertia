import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeAdvertisedSurface,
  codexAdvertisedSurface,
  createSurfaceRuntime,
  httpMcpAdvertisedSurface,
  type AdvertisedSurface,
} from "../helpers/agent-tool-surface";

const BUDGET_PATH = resolve("tests/fixtures/agent-surface-budget.json");
const UPDATE_FLAG = "INERTIA_UPDATE_AGENT_SURFACE_BUDGET";
const REBASELINE = `${UPDATE_FLAG}=1 npm test -- tests/server/agent-surface-budget.test.ts`;
const PROVIDERS = ["claude", "codex", "cursorKimi", "opencode"] as const;

type Provider = (typeof PROVIDERS)[number];
type Variant = "withBrowser" | "withoutBrowser";

interface SurfaceBudget {
  rebaseline: string;
  unit: string;
  tools: Record<string, Record<Provider, number>>;
  instructions: Record<string, number>;
  totals: Record<Provider, Record<Variant, number>>;
}

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

async function measureVariant(browser: boolean) {
  const runtime = await createSurfaceRuntime(browser
    ? { browser: { perform: async () => ({ ok: false, code: "unavailable", message: "Not used." }) } }
    : {});
  try {
    const surfaces: Record<Provider, AdvertisedSurface> = {
      claude: await claudeAdvertisedSurface(runtime.bridge),
      codex: await codexAdvertisedSurface(runtime.bridge),
      cursorKimi: await httpMcpAdvertisedSurface(runtime.bridge, {}),
      opencode: await httpMcpAdvertisedSurface(runtime.bridge, { destructiveHints: true }),
    };
    return { surfaces, hidden: runtime.manager.capabilityInstructions() };
  } finally {
    await runtime.close();
  }
}

async function measure(): Promise<SurfaceBudget> {
  const variants = {
    withBrowser: await measureVariant(true),
    withoutBrowser: await measureVariant(false),
  };
  const tools: SurfaceBudget["tools"] = {};
  for (const provider of PROVIDERS) {
    for (const tool of variants.withBrowser.surfaces[provider].tools) {
      tools[tool.name] = { ...tools[tool.name], [provider]: bytes(JSON.stringify(tool)) } as Record<Provider, number>;
    }
  }
  const instructions: SurfaceBudget["instructions"] = {};
  for (const instruction of variants.withBrowser.hidden) instructions[instruction.label] = bytes(instruction.text);
  instructions["mcp-initialize:claude"] = bytes(variants.withBrowser.surfaces.claude.instructions ?? "");
  instructions["mcp-initialize:http"] = bytes(variants.withBrowser.surfaces.cursorKimi.instructions ?? "");
  const totals = {} as SurfaceBudget["totals"];
  for (const provider of PROVIDERS) {
    const total = (variant: Variant): number => {
      const { surfaces, hidden } = variants[variant];
      return surfaces[provider].tools.reduce((sum, tool) => sum + bytes(JSON.stringify(tool)), 0)
        + bytes(surfaces[provider].instructions ?? "")
        + hidden.reduce((sum, instruction) => sum + bytes(instruction.text), 0);
    };
    totals[provider] = { withBrowser: total("withBrowser"), withoutBrowser: total("withoutBrowser") };
  }
  return { rebaseline: REBASELINE, unit: "UTF-8 bytes", tools, instructions, totals };
}

function flatten(value: unknown, prefix = ""): Map<string, number> {
  const result = new Map<string, number>();
  if (typeof value === "number") return result.set(prefix, value);
  if (value === null || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    for (const entry of flatten(child, prefix ? `${prefix}.${key}` : key)) result.set(...entry);
  }
  return result;
}

function table(measured: Map<string, number>, committed: Map<string, number>): string {
  const width = Math.max(...[...measured.keys()].map((key) => key.length));
  return [...measured].map(([key, value]) => {
    const previous = committed.get(key);
    const delta = previous === undefined ? "new" : value - previous === 0 ? "" : `${value - previous > 0 ? "+" : ""}${value - previous}`;
    return `${key.padEnd(width)}  ${String(value).padStart(7)}  ${delta}`;
  }).join("\n");
}

function committedBudget(): Map<string, number> {
  try {
    return flatten(JSON.parse(readFileSync(BUDGET_PATH, "utf8")));
  } catch {
    return new Map();
  }
}

describe(
  "agent surface byte budget: every tool entry and instruction an agent sees stays at or under tests/fixtures/agent-surface-budget.json",
  () => {
    it(
      "measures Claude (in-process MCP tools/list plus its initialize instructions), Codex (thread/start dynamicTools), "
        + "Cursor and Kimi (HTTP MCP tools/list plus initialize instructions), and OpenCode (the same HTTP MCP with destructive hints); "
        + "totals add the hidden capability instructions and are taken with the Browser broker wired (withBrowser, frontend workbench advertised) and without it",
      async () => {
        const budget = await measure();
        const measured = flatten(budget);
        const committed = committedBudget();
        if (process.env[UPDATE_FLAG] === "1") {
          writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, 2)}\n`);
          process.stdout.write(`Agent surface budget rewritten (${BUDGET_PATH}):\n${table(measured, committed)}\n`);
          return;
        }
        const growth = [...measured].flatMap(([key, value]) => {
          const limit = committed.get(key);
          if (limit === undefined) return [`${key} is ${value} bytes and has no committed budget`];
          return value > limit ? [`${key} grew from ${limit} to ${value} bytes (+${value - limit})`] : [];
        });
        expect(growth, `The agent-visible surface grew. Shrink it, or re-baseline deliberately with: ${REBASELINE}`)
          .toEqual([]);
      },
    );
  },
);
