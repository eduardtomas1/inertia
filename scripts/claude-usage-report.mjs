import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TOKEN_WEIGHTS = Object.freeze({
  input: 1,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  output: 5,
});

export const LARGE_CONTEXT_TOKENS = 400_000;
const REBUILD_MIN_CONTEXT_TOKENS = 20_000;
const HEAD_LINES = 400;
const MINUTE_MS = 60_000;

const INERTIA_MARKERS = ["inertia-selected-skills:", "\"name\":\"mcp__inertia-chat-manager__", "Internal provider instructions"];
const T3_MARKERS = ["mcp__t3-code__t3_", "T3 Code orchestration"];

function count(text, marker) {
  let found = 0;
  let index = text.indexOf(marker);
  while (index !== -1) {
    found += 1;
    index = text.indexOf(marker, index + marker.length);
  }
  return found;
}

export function classifyTranscriptHead(text) {
  const inertia = INERTIA_MARKERS.reduce((sum, marker) => sum + count(text, marker), 0);
  const t3 = T3_MARKERS.reduce((sum, marker) => sum + count(text, marker), 0);
  if (inertia > t3) return "inertia";
  if (t3 > inertia) return "t3-code";
  return "other";
}

function tokens(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function weighUsage(usage) {
  const cacheWrite = tokens(usage.cache_creation_input_tokens);
  const split = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const write5m = split ? tokens(split.ephemeral_5m_input_tokens) : 0;
  const write1h = split ? tokens(split.ephemeral_1h_input_tokens) : 0;
  const unsplit = Math.max(0, cacheWrite - write5m - write1h);
  return tokens(usage.input_tokens) * TOKEN_WEIGHTS.input
    + tokens(usage.cache_read_input_tokens) * TOKEN_WEIGHTS.cacheRead
    + write5m * TOKEN_WEIGHTS.cacheWrite5m
    + (write1h + unsplit) * TOKEN_WEIGHTS.cacheWrite1h
    + tokens(usage.output_tokens) * TOKEN_WEIGHTS.output;
}

export function contextTokens(usage) {
  return tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens) + tokens(usage.cache_read_input_tokens);
}

export function summarizeTranscriptLines(lines) {
  const calls = new Map();
  const compactions = [];
  let entrypoint = null;
  for (const line of lines) {
    if (entrypoint === null && line.includes("\"entrypoint\"")) {
      const match = /"entrypoint"\s*:\s*"([^"]+)"/u.exec(line);
      if (match) entrypoint = match[1];
    }
    if (line.includes("compact_boundary")) {
      const record = parse(line);
      if (record?.subtype === "compact_boundary") {
        compactions.push({
          at: typeof record.timestamp === "string" ? record.timestamp : null,
          trigger: typeof record.compactMetadata?.trigger === "string" ? record.compactMetadata.trigger : "unknown",
          preTokens: tokens(record.compactMetadata?.preTokens),
        });
      }
      continue;
    }
    if (!line.includes("\"assistant\"") || !line.includes("\"usage\"")) continue;
    const record = parse(line);
    if (record?.type !== "assistant") continue;
    const message = record.message;
    if (!message || typeof message !== "object" || !message.usage || message.model === "<synthetic>") continue;
    const id = typeof message.id === "string" ? message.id : `${record.uuid}`;
    calls.set(id, {
      at: typeof record.timestamp === "string" ? record.timestamp : null,
      model: typeof message.model === "string" ? message.model : null,
      usage: message.usage,
    });
  }
  return {
    entrypoint,
    compactions,
    calls: [...calls.values()].sort((left, right) => (left.at ?? "").localeCompare(right.at ?? "")),
  };
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function inWindow(at, window) {
  if (at === null) return window.since === null && window.until === null;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return false;
  return (window.since === null || time >= window.since) && (window.until === null || time < window.until);
}

function emptyGroup() {
  return {
    sessions: 0,
    calls: 0,
    outputTokens: 0,
    weightedTokens: 0,
    contextTokens: 0,
    largeContextCalls: 0,
    compactions: { auto: 0, manual: 0, other: 0, preTokens: 0 },
    rebuilds: {
      afterHour: { count: 0, weightedTokens: 0 },
      afterMinutes: { count: 0, weightedTokens: 0 },
      quick: { count: 0, weightedTokens: 0 },
    },
  };
}

export function aggregateSessions(sessions, window = { since: null, until: null }) {
  const groups = {};
  for (const session of sessions) {
    const key = `${session.app}:${session.subagent ? "subagent" : "main"}`;
    const group = groups[key] ??= emptyGroup();
    let counted = false;
    let previousAt = null;
    for (const call of session.calls) {
      const at = call.at;
      const included = inWindow(at, window);
      const context = contextTokens(call.usage);
      const weighted = weighUsage(call.usage);
      if (included) {
        counted = true;
        group.calls += 1;
        group.outputTokens += tokens(call.usage.output_tokens);
        group.weightedTokens += weighted;
        group.contextTokens += context;
        if (context > LARGE_CONTEXT_TOKENS) group.largeContextCalls += 1;
        const written = tokens(call.usage.cache_creation_input_tokens);
        if (previousAt !== null && context > REBUILD_MIN_CONTEXT_TOKENS && written > context / 2) {
          const gapMs = Date.parse(at) - Date.parse(previousAt);
          const bucket = gapMs > 60 * MINUTE_MS ? "afterHour" : gapMs > 5 * MINUTE_MS ? "afterMinutes" : "quick";
          group.rebuilds[bucket].count += 1;
          group.rebuilds[bucket].weightedTokens += weighted;
        }
      }
      previousAt = at;
    }
    for (const compaction of session.compactions) {
      if (!inWindow(compaction.at, window)) continue;
      const trigger = compaction.trigger === "auto" || compaction.trigger === "manual" ? compaction.trigger : "other";
      group.compactions[trigger] += 1;
      group.compactions.preTokens += compaction.preTokens;
    }
    if (counted) group.sessions += 1;
  }
  return groups;
}

export function groupMetrics(group) {
  return {
    sessions: group.sessions,
    calls: group.calls,
    outputTokens: group.outputTokens,
    weightedTokens: Math.round(group.weightedTokens),
    weightedPerOutputToken: group.outputTokens > 0 ? group.weightedTokens / group.outputTokens : null,
    averageContextTokens: group.calls > 0 ? group.contextTokens / group.calls : null,
    largeContextShare: group.calls > 0 ? group.largeContextCalls / group.calls : null,
    compactions: group.compactions.auto + group.compactions.manual + group.compactions.other,
    averageTokensAtCompaction: group.compactions.auto + group.compactions.manual + group.compactions.other > 0
      ? group.compactions.preTokens / (group.compactions.auto + group.compactions.manual + group.compactions.other)
      : null,
    rebuilds: group.rebuilds,
  };
}

function* walk(root) {
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        yield { path: join(projectPath, entry.name), subagent: false };
      } else if (entry.isDirectory()) {
        const subagents = join(projectPath, entry.name, "subagents");
        if (!existsSync(subagents)) continue;
        for (const child of readdirSync(subagents, { withFileTypes: true })) {
          if (child.isFile() && child.name.endsWith(".jsonl")) {
            yield { path: join(subagents, child.name), subagent: true, parent: join(projectPath, `${entry.name}.jsonl`) };
          }
        }
      }
    }
  }
}

async function readTranscript(path) {
  const lines = [];
  const head = [];
  const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of input) {
    if (head.length < HEAD_LINES) head.push(line);
    if (line.includes("\"assistant\"") || line.includes("compact_boundary") || line.includes("\"entrypoint\"")) lines.push(line);
  }
  return { head: head.join("\n"), summary: summarizeTranscriptLines(lines) };
}

export async function analyzeClaudeProjects({ root, since = null, until = null }) {
  const window = { since: since === null ? null : Date.parse(since), until: until === null ? null : Date.parse(until) };
  const apps = new Map();
  const files = [...walk(root)].filter(({ path }) => window.since === null || statSync(path).mtimeMs >= window.since);
  const sessions = [];
  for (const file of files.filter(({ subagent }) => !subagent)) {
    const { head, summary } = await readTranscript(file.path);
    const app = classifyTranscriptHead(head);
    apps.set(file.path, app);
    sessions.push({ app, subagent: false, ...summary });
  }
  for (const file of files.filter(({ subagent }) => subagent)) {
    const { summary } = await readTranscript(file.path);
    let app = apps.get(file.parent);
    if (app === undefined) {
      app = existsSync(file.parent) ? classifyTranscriptHead((await readTranscript(file.parent)).head) : "other";
      apps.set(file.parent, app);
    }
    sessions.push({ app, subagent: true, ...summary });
  }
  const groups = aggregateSessions(sessions, window);
  return {
    root,
    since,
    until,
    weights: TOKEN_WEIGHTS,
    groups: Object.fromEntries(Object.entries(groups)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => [key, groupMetrics(group)])),
  };
}

function thousands(value) {
  return value === null ? "–" : `${Math.round(value / 1000).toLocaleString("en-US")}K`;
}

function millions(value) {
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsageReport(report) {
  const rows = [
    ["group", "sessions", "calls", "weighted", "per output", "avg context", `>${LARGE_CONTEXT_TOKENS / 1000}K`, "compactions", "idle >1h rebuilds", "5–60 min rebuilds"],
  ];
  for (const [key, metrics] of Object.entries(report.groups)) {
    if (metrics.calls === 0) continue;
    rows.push([
      key,
      String(metrics.sessions),
      String(metrics.calls),
      millions(metrics.weightedTokens),
      metrics.weightedPerOutputToken === null ? "–" : metrics.weightedPerOutputToken.toFixed(1),
      thousands(metrics.averageContextTokens),
      metrics.largeContextShare === null ? "–" : `${Math.round(metrics.largeContextShare * 100)}%`,
      metrics.compactions === 0 ? "0" : `${metrics.compactions} at ${thousands(metrics.averageTokensAtCompaction)}`,
      `${metrics.rebuilds.afterHour.count} · ${millions(metrics.rebuilds.afterHour.weightedTokens)}`,
      `${metrics.rebuilds.afterMinutes.count} · ${millions(metrics.rebuilds.afterMinutes.weightedTokens)}`,
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const table = rows.map((row) => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join("  "));
  const span = `${report.since ?? "the beginning"} to ${report.until ?? "now"}`;
  return [
    `Claude Code usage in ${report.root}, ${span}.`,
    "Weighted tokens use API price ratios: input 1, cache read 0.1, 5-minute cache write 1.25, 1-hour cache write 2, output 5.",
    "",
    ...table,
  ].join("\n");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const days = option(args, "--days");
  const explicitSince = option(args, "--since");
  const until = option(args, "--until");
  const invalid = (days !== null && !(Number.isFinite(Number(days)) && Number(days) > 0) && "--days needs a positive number.")
    || (explicitSince !== null && !Number.isFinite(Date.parse(explicitSince)) && "--since needs an ISO date or time.")
    || (until !== null && !Number.isFinite(Date.parse(until)) && "--until needs an ISO date or time.");
  if (invalid) {
    console.error(invalid);
    process.exit(1);
  }
  const since = explicitSince ?? (days === null ? null : new Date(Date.now() - Number(days) * 86_400_000).toISOString());
  const root = option(args, "--projects") ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) {
    console.error(`No Claude Code projects folder at ${root}.`);
    process.exit(1);
  }
  const report = await analyzeClaudeProjects({ root, since, until });
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatUsageReport(report));
}
