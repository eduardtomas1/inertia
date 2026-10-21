import { promises } from "node:fs";
import { posix, win32 } from "node:path";

import {
  OUTSIDE_WORKSPACE,
  readOnlyCommandOperands,
  type ReadOnlyCommandContext,
  type ReadOnlyCommandOperand,
} from "./read-only-commands";

export const MAX_READ_ONLY_COMMAND_PATHS = 4_096;

const TOO_MANY_PATHS = "The command names more paths than watchers can check.";
const MISSING = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "EINVAL"]);
const WILDCARDS = new Set(["*", "?", "["]);

export interface ReadOnlyCommandFileSystem {
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const NODE_FILE_SYSTEM: ReadOnlyCommandFileSystem = {
  realpath: (path) => promises.realpath(path),
  readdir: (path) => promises.readdir(path),
};

interface Segment {
  text: string;
  glob: boolean[];
}

export async function readOnlyCommandPathProblem(
  command: string,
  context: ReadOnlyCommandContext,
  files: ReadOnlyCommandFileSystem = NODE_FILE_SYSTEM,
): Promise<string | null> {
  const paths = context.windows ? win32 : posix;
  const cwd = paths.resolve(context.cwd);
  const workspace = await realPath(files, cwd);
  if (workspace === undefined) return OUTSIDE_WORKSPACE;
  const root = workspace ?? cwd;
  const wildcards = context.windows || context.powershell === true;
  const targets = new Set<string>();
  for (const operand of readOnlyCommandOperands(command, context)) {
    for (const target of await expand(files, paths, cwd, operand, wildcards, MAX_READ_ONLY_COMMAND_PATHS - targets.size)) {
      targets.add(target);
    }
    if (targets.size >= MAX_READ_ONLY_COMMAND_PATHS) return TOO_MANY_PATHS;
  }
  const resolved = await Promise.all([...targets].map((target) => realPath(files, target)));
  return resolved.every((real) => real === null || (real !== undefined && inside(paths, root, real))) ? null : OUTSIDE_WORKSPACE;
}

async function realPath(files: ReadOnlyCommandFileSystem, path: string): Promise<string | null | undefined> {
  try {
    return await files.realpath(path);
  } catch (error) {
    return MISSING.has((error as NodeJS.ErrnoException).code ?? "") ? null : undefined;
  }
}

function inside(paths: typeof posix, root: string, path: string): boolean {
  const relative = paths.relative(root, path);
  return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

async function expand(
  files: ReadOnlyCommandFileSystem,
  paths: typeof posix,
  cwd: string,
  operand: ReadOnlyCommandOperand,
  wildcards: boolean,
  limit: number,
): Promise<string[]> {
  const separators = paths === win32 ? /[\\/]/u : /\//u;
  const segments = split(operand, separators, wildcards);
  const first = segments.findIndex(({ glob }) => glob.includes(true));
  if (first < 0) return [paths.resolve(cwd, operand.value)];
  const prefix = segments.slice(0, first).map(({ text }) => text).join("/");
  let current = [paths.resolve(cwd, first === 0 ? "." : `${prefix}/`)];
  for (const segment of segments.slice(first)) {
    if (!segment.glob.includes(true)) {
      current = current.map((directory) => paths.join(directory, segment.text));
      continue;
    }
    const matcher = segmentMatcher(segment);
    const next: string[] = [];
    for (const directory of current) {
      let names: string[];
      try {
        names = await files.readdir(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!matcher.test(name)) continue;
        next.push(paths.join(directory, name));
        if (next.length > limit) return next;
      }
    }
    current = next;
  }
  return current;
}

function split(operand: ReadOnlyCommandOperand, separators: RegExp, wildcards: boolean): Segment[] {
  const segments: Segment[] = [{ text: "", glob: [] }];
  for (let index = 0; index < operand.value.length; index += 1) {
    const character = operand.value[index]!;
    if (separators.test(character)) {
      segments.push({ text: "", glob: [] });
      continue;
    }
    const segment = segments.at(-1)!;
    segment.text += character;
    segment.glob.push(operand.glob[index] === true || (wildcards && WILDCARDS.has(character)));
  }
  return segments;
}

function segmentMatcher({ text, glob }: Segment): RegExp {
  if (glob.some((wildcard, index) => wildcard && text[index] === "[")) return /^/u;
  let source = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (glob[index] && character === "*") source += ".*";
    else if (glob[index] && character === "?") source += ".";
    else source += character.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "isu");
}
