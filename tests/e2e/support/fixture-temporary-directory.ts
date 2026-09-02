import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFixtureTemporaryDirectories(): Promise<{
  processTemporaryDirectory: string;
  testDirectory: string;
}> {
  // This root also contains Chromium's ProcessSingleton socket. Its compact
  // basename keeps macOS's longer system temp paths below Unix socket limits.
  const testDirectory = await mkdtemp(join(tmpdir(), "ie-"));
  const processTemporaryDirectory = join(testDirectory, "t");
  await mkdir(processTemporaryDirectory, { recursive: true, mode: 0o700 });
  return { processTemporaryDirectory, testDirectory };
}

export function fixtureTemporaryEnvironment(
  processTemporaryDirectory: string,
): Record<"TEMP" | "TMP" | "TMPDIR", string> {
  // Electron and Node consult different variables across desktop platforms.
  return {
    TEMP: processTemporaryDirectory,
    TMP: processTemporaryDirectory,
    TMPDIR: processTemporaryDirectory,
  };
}
