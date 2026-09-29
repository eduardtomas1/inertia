import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

export function readStableFixtureCapture<T>(capturePath: string): T {
  let lastError: unknown;
  for (const candidate of [`${capturePath}.next`, capturePath]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No fixture capture was written to ${capturePath}.`);
}

export function fixtureCaptureWriterSource(capturePath: string): string {
  return `((value) => {
  const nextPath = ${JSON.stringify(`${capturePath}.next`)};
  fs.writeFileSync(nextPath, JSON.stringify(value));
  try {
    fs.renameSync(nextPath, ${JSON.stringify(capturePath)});
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    fs.copyFileSync(nextPath, ${JSON.stringify(capturePath)});
    fs.unlinkSync(nextPath);
  }
})`;
}

/**
 * Create a portable executable for CLIs whose protocol is selected by a flag
 * (for example `agy --output-format stream-json`) instead of a Node-compatible subcommand.
 */
export function writeNodeFlagExecutable(
  root: string,
  name: string,
  source: string,
): string {
  const script = join(root, `${name}-fixture.cjs`);
  writeFileSync(script, `${source.trimStart()}\n`, "utf8");
  if (process.platform === "win32") {
    const executable = join(root, `${name}.cmd`);
    writeFileSync(
      executable,
      `@echo off\r\n"${process.execPath}" "%~dp0${name}-fixture.cjs" %*\r\n`,
      "utf8",
    );
    return executable;
  }
  const executable = join(root, name);
  writeFileSync(
    executable,
    `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return executable;
}

export function writeNodeClaudeExecutable(root: string, source: string): string {
  if (process.platform !== "win32") return writeNodeFlagExecutable(root, "claude", source);
  const packageDirectory = join(root, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }),
    "utf8",
  );
  writeFileSync(join(packageDirectory, "cli.js"), `${source.trimStart()}\n`, "utf8");
  copyFileSync(process.execPath, join(root, "node.exe"));
  const executable = join(root, "claude.cmd");
  writeFileSync(
    executable,
    "@echo off\r\n\"%~dp0node.exe\" \"%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n",
    "utf8",
  );
  return executable;
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

export interface FixtureRemovalDependencies {
  remove(root: string): void;
  wait(milliseconds: number): Promise<void>;
}

const nodeFixtureRemoval: FixtureRemovalDependencies = {
  remove: (root) => rmSync(root, { recursive: true, force: true }),
  wait: (milliseconds) => delay(milliseconds),
};

export async function removePortableFixture(root: string): Promise<void> {
  await removeFixtureDirectory(root, nodeFixtureRemoval);
}

export async function removeFixtureDirectory(
  root: string,
  dependencies: FixtureRemovalDependencies,
): Promise<void> {
  const retryDelays = [0, 50, 150, 350, 750, 1_500];
  let lastError: unknown;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await dependencies.wait(retryDelay);
    try {
      dependencies.remove(root);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
      lastError = error;
    }
  }
  const waitedMs = retryDelays.reduce((total, retryDelay) => total + retryDelay, 0);
  throw new Error(
    `Fixture directory ${root} could not be removed after ${retryDelays.length} attempts over ${waitedMs} ms: ${(lastError as Error).message}`,
    { cause: lastError },
  );
}
