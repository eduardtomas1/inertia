import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { discoverPortableTests } from "./portable-test-manifest.mjs";

const repositoryRoot = process.cwd();
const forwardedArguments = process.argv.slice(2);
const listOnlyIndex = forwardedArguments.indexOf("--list");
const listOnly = listOnlyIndex >= 0;
if (listOnly) forwardedArguments.splice(listOnlyIndex, 1);

const manifest = await discoverPortableTests(repositoryRoot);
if (listOnly) {
  process.stdout.write(`${manifest.files.join("\n")}\n`);
} else {
  const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--maxWorkers=1", ...forwardedArguments, ...manifest.files],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
