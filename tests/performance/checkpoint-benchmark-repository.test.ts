import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCheckpointBenchmarkRepository } from
  "../helpers/checkpoint-benchmark-repository";

const execFileAsync = promisify(execFile);

describe("checkpoint benchmark repository", () => {
  it("commits 12,000 files without Git output when the user configuration converts line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-checkpoint-fixture-"));
    try {
      const globalConfig = join(root, "gitconfig");
      await writeFile(globalConfig, "[core]\n\tautocrlf = true\n\tsafecrlf = warn\n");
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      };
      const repository = join(root, "repository");

      const result = await createCheckpointBenchmarkRepository(repository, 12_000, env);

      expect(result.stderr).toBe("");
      const tracked = await execFileAsync("git", ["ls-files", "-z"], {
        cwd: repository,
        env,
        maxBuffer: 4 * 1_048_576,
      });
      expect(tracked.stdout.split("\0").filter(Boolean)).toHaveLength(12_000);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        ...(process.platform === "win32"
          ? { maxRetries: 8, retryDelay: 100 }
          : {}),
      });
    }
  }, 120_000);
});
