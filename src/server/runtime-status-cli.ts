import { pathToFileURL } from "node:url";

import {
  collectRuntimeStatus,
  RuntimeStatusError,
} from "./runtime-status";

const HELP = `Usage: npm run --silent status:runtime -- [--cwd PATH] [--pretty]

Print a credential-free runtime readiness report as JSON.

Options:
  --cwd PATH  Inspect PATH instead of the current directory
  --pretty    Pretty-print JSON
  --help      Show this help
`;

export interface RuntimeStatusCliArguments {
  cwd?: string;
  pretty: boolean;
  help: boolean;
}

export function parseRuntimeStatusCliArguments(
  arguments_: readonly string[],
): RuntimeStatusCliArguments {
  const parsed: RuntimeStatusCliArguments = { pretty: false, help: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--pretty") {
      parsed.pretty = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--cwd") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--") || value.length > 32_768) {
        throw new RuntimeStatusError("--cwd requires a bounded path.");
      }
      parsed.cwd = value;
      index += 1;
      continue;
    }
    throw new RuntimeStatusError("Unknown status option.");
  }
  return parsed;
}

export async function runRuntimeStatusCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const parsed = parseRuntimeStatusCliArguments(arguments_);
    if (parsed.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const report = await collectRuntimeStatus({ cwd: parsed.cwd });
    process.stdout.write(`${JSON.stringify(report, null, parsed.pretty ? 2 : 0)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof RuntimeStatusError
      ? error.message
      : "Runtime readiness could not be checked.";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedUrl === import.meta.url) {
  void runRuntimeStatusCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
