import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createCheckpointBenchmarkRepository(
  root: string,
  files: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stderr: string }> {
  let stderr = "";
  const git = async (args: string[]): Promise<void> => {
    const result = await execFileAsync("git", args, { cwd: root, env });
    stderr += result.stderr;
  };
  await mkdir(root);
  await git(["init", "-q"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["config", "core.safecrlf", "false"]);
  for (let start = 0; start < files; start += 500) {
    await Promise.all(Array.from(
      { length: Math.min(500, files - start) },
      async (_, offset) => {
        const index = start + offset;
        const directory = join(root, `module-${Math.floor(index / 100)}`);
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `file-${index}.ts`),
          `export const value${index} = ${index};\n`,
        );
      },
    ));
  }
  await git(["-c", "gc.auto=0", "add", "-A"]);
  await git([
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "user.name=Inertia Benchmark",
    "-c",
    "user.email=benchmark@inertia.local",
    "commit",
    "-qm",
    "fixture",
  ]);
  await writeFile(join(root, "module-0", "file-0.ts"), "export const value0 = -1;\n");
  await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n");
  return { stderr };
}
