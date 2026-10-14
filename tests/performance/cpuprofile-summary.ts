import { readFile } from "node:fs/promises";

interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface CpuProfileSummary {
  windowMs: number;
  sampledMs: number;
  idleMs: number;
  programMs: number;
  garbageCollectorMs: number;
  topFunctions: Array<{ key: string; selfMs: number; share: number }>;
  topUrls: Array<{ url: string; selfMs: number; share: number }>;
  topInclusive: Array<{ key: string; totalMs: number; share: number }>;
}

function shortUrl(url: string): string {
  const marker = url.lastIndexOf("/out/");
  if (marker >= 0) return url.slice(marker + 1);
  const modules = url.lastIndexOf("/node_modules/");
  if (modules >= 0) return url.slice(modules + 1);
  return url;
}

export function summarizeCpuProfile(
  profile: CpuProfile,
  options: { windowMs?: number; top?: number } = {},
): CpuProfileSummary {
  const top = options.top ?? 30;
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const self = new Map<number, number>();
  let elapsedUs = 0;
  const windowUs = options.windowMs === undefined ? Number.POSITIVE_INFINITY : options.windowMs * 1_000;
  for (let index = 0; index < profile.samples.length; index += 1) {
    elapsedUs += profile.timeDeltas[index] ?? 0;
    if (elapsedUs > windowUs) break;
    const next = profile.timeDeltas[index + 1] ?? 0;
    const id = profile.samples[index]!;
    self.set(id, (self.get(id) ?? 0) + next);
  }
  const keyOf = (node: CpuProfileNode): string => {
    const { functionName, url, lineNumber } = node.callFrame;
    return `${functionName || "(anonymous)"} ${shortUrl(url)}:${lineNumber + 1}`;
  };
  const functions = new Map<string, number>();
  const urls = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let idleUs = 0;
  let programUs = 0;
  let gcUs = 0;
  let sampledUs = 0;
  for (const [id, us] of self) {
    const node = byId.get(id);
    if (!node) continue;
    sampledUs += us;
    const name = node.callFrame.functionName;
    if (name === "(idle)") { idleUs += us; continue; }
    if (name === "(program)") programUs += us;
    if (name === "(garbage collector)") gcUs += us;
    const key = keyOf(node);
    functions.set(key, (functions.get(key) ?? 0) + us);
    const url = shortUrl(node.callFrame.url) || name;
    urls.set(url, (urls.get(url) ?? 0) + us);
    const seen = new Set<string>();
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      const current = byId.get(cursor);
      if (!current) break;
      const currentKey = keyOf(current);
      if (!seen.has(currentKey)) {
        seen.add(currentKey);
        inclusive.set(currentKey, (inclusive.get(currentKey) ?? 0) + us);
      }
      cursor = parent.get(cursor);
    }
  }
  const busyUs = Math.max(1, sampledUs - idleUs);
  const ranked = <T extends string>(entries: Map<string, number>, label: T) => [...entries]
    .sort((left, right) => right[1] - left[1])
    .slice(0, top)
    .map(([key, us]) => ({ [label]: key, ms: Math.round(us / 10) / 100, share: Math.round((us / busyUs) * 1_000) / 1_000 }));
  return {
    windowMs: Math.round(Math.min(elapsedUs, windowUs) / 1_000),
    sampledMs: Math.round(sampledUs / 1_000),
    idleMs: Math.round(idleUs / 1_000),
    programMs: Math.round(programUs / 1_000),
    garbageCollectorMs: Math.round(gcUs / 1_000),
    topFunctions: ranked(functions, "key").map(({ key, ms, share }) => ({ key: String(key), selfMs: ms, share })),
    topUrls: ranked(urls, "url").map(({ url, ms, share }) => ({ url: String(url), selfMs: ms, share })),
    topInclusive: ranked(inclusive, "key")
      .filter(({ key }) => !String(key).startsWith("(root)"))
      .map(({ key, ms, share }) => ({ key: String(key), totalMs: ms, share })),
  };
}

export async function summarizeCpuProfileFile(
  path: string,
  options: { windowMs?: number; top?: number } = {},
): Promise<CpuProfileSummary> {
  return summarizeCpuProfile(JSON.parse(await readFile(path, "utf8")) as CpuProfile, options);
}
