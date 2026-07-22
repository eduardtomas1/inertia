import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export function portableFixtureRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `inertia ${label} fixture with spaces-`));
}

/**
 * A native Node executable is available on every host. Provider subcommands
 * can therefore be plain CommonJS files in the fixture cwd: when
 * production spawns `<executable> app-server`, Node executes `./app-server`.
 */
export function portableNodeExecutable(root: string, name: string): string {
  const executable = join(root, process.platform === "win32" ? `${name}.exe` : name);
  // Official Windows node.exe builds are self-contained. Unix installations
  // may load libnode relative to the original binary, so retain that location
  // through a symlink instead of relocating the executable.
  if (process.platform === "win32") copyFileSync(process.execPath, executable);
  else symlinkSync(process.execPath, executable);
  return executable;
}

export function writeNodeSubcommand(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, `${source.trimStart()}\n`, "utf8");
  return path;
}

export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  } while (Date.now() < deadline);
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}.${detail}`);
}

export async function loopbackPortIsOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function removePortableFixture(root: string): Promise<void> {
  const retryDelays = process.platform === "win32" ? [0, 50, 150, 350, 750, 1_500] : [0];
  let lastError: unknown;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await delay(retryDelay);
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
