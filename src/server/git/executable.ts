import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

const FILESYSTEM_SELECTION_BUDGET_MS = 1_000;
const MAXIMUM_PATH_LENGTH = 16_384;
const MAXIMUM_PATH_ENTRIES = 128;
const WINDOWS_GIT_EXTENSIONS = [".com", ".exe"] as const;
const WINDOWS_FULLY_QUALIFIED_DIRECTORY = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u;

function windowsPathEntries(path: string): string[] {
  return path.split(";")
    .map(entry => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter(entry => WINDOWS_FULLY_QUALIFIED_DIRECTORY.test(entry) && !/[\0"]/u.test(entry));
}

async function withinFilesystemBudget(
  budget: { remainingMs: number },
  operation: (expired: () => boolean) => Promise<string | null>,
): Promise<string | null> {
  if (budget.remainingMs <= 0) return null;
  const started = performance.now();
  const deadline = started + budget.remainingMs;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(() => expired || performance.now() >= deadline),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(null); }, budget.remainingMs);
        timer.unref();
      }),
    ]);
    return expired || performance.now() >= deadline ? null : result;
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
    budget.remainingMs -= Math.max(0, performance.now() - started);
  }
}

async function executableRealpath(path: string): Promise<string | null> {
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) return null;
    return await realpath(path);
  } catch { return null; }
}

async function windowsExecutableFile(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch { return null; }
}

/** Select Apple's real Git once without changing a custom PATH selection. */
export class GitExecutableSelection {
  private selection: {
    path: string;
    command: string;
    preparation: Promise<void>;
  } | null = null;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly readExecutable: (path: string) => Promise<string | null> =
      platform === "win32" ? windowsExecutableFile : executableRealpath,
  ) {}

  command(environment: NodeJS.ProcessEnv): string {
    return this.selection && this.selection.path === this.searchPath(environment) ? this.selection.command : "git";
  }

  prepare(environment: NodeJS.ProcessEnv, locateAppleGit: () => Promise<string>): Promise<void> {
    if (this.platform === "win32") return this.prepareWindows(environment);
    if (this.platform !== "darwin") return Promise.resolve();
    const path = environment.PATH;
    // Relative/empty entries can choose a different executable for each cwd.
    // Leave those invocations to their existing PATH semantics. Bound startup
    // filesystem discovery even when the inherited PATH is unusually large.
    if (!path || path.length > MAXIMUM_PATH_LENGTH) return Promise.resolve();
    const entries = path.split(":");
    if (entries.length > MAXIMUM_PATH_ENTRIES || entries.some(entry => !posix.isAbsolute(entry))) return Promise.resolve();
    if (this.selection?.path === path) return this.selection.preparation;
    const selection = { path, command: "git", preparation: Promise.resolve() };
    this.selection = selection;
    selection.preparation = (async () => {
      // Share one filesystem budget; do not reset it for each PATH entry or
      // race away the separately bounded owned helper's cleanup once spawned.
      const budget = { remainingMs: FILESYSTEM_SELECTION_BUDGET_MS };
      const selected = await withinFilesystemBudget(budget, async expired => {
        for (const entry of entries) {
          const executable = await this.readExecutable(posix.join(entry, "git"));
          if (expired()) return null;
          if (executable) return executable;
        }
        return null;
      });
      if (selected !== "/usr/bin/git") return;
      // xcrun applies the selected Xcode/toolchain policy. Its environment
      // is sanitized by the same privileged runner used for Git commands.
      const located = (await locateAppleGit()).trim();
      if (!posix.isAbsolute(located) || /[\0\r\n]/u.test(located)) return;
      const executable = await withinFilesystemBudget(budget, () => this.readExecutable(located));
      if (executable && executable !== "/usr/bin/git") selection.command = executable;
    })();
    return selection.preparation;
  }

  private searchPath(environment: NodeJS.ProcessEnv): string | undefined {
    if (this.platform !== "win32") return environment.PATH;
    const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === "PATH");
    return key === undefined ? undefined : environment[key];
  }

  private prepareWindows(environment: NodeJS.ProcessEnv): Promise<void> {
    const path = this.searchPath(environment);
    if (!path || path.length > MAXIMUM_PATH_LENGTH) return Promise.resolve();
    const entries = windowsPathEntries(path);
    if (entries.length === 0 || entries.length > MAXIMUM_PATH_ENTRIES) return Promise.resolve();
    if (this.selection?.path === path) return this.selection.preparation;
    const selection = { path, command: "git", preparation: Promise.resolve() };
    this.selection = selection;
    selection.preparation = (async () => {
      const budget = { remainingMs: FILESYSTEM_SELECTION_BUDGET_MS };
      const selected = await withinFilesystemBudget(budget, async expired => {
        for (const entry of entries) {
          for (const extension of WINDOWS_GIT_EXTENSIONS) {
            const candidate = win32.join(entry, `git${extension}`);
            const executable = await this.readExecutable(candidate);
            if (expired()) return null;
            if (executable) return candidate;
          }
        }
        return null;
      });
      if (selected && WINDOWS_FULLY_QUALIFIED_DIRECTORY.test(selected) && !/[\0\r\n]/u.test(selected)) {
        selection.command = selected;
      }
    })();
    return selection.preparation;
  }
}
