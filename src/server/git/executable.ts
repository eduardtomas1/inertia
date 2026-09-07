import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const FILESYSTEM_SELECTION_BUDGET_MS = 1_000;

async function withinFilesystemBudget(
  budget: { remainingMs: number },
  operation: (expired: () => boolean) => Promise<string | null>,
): Promise<string | null> {
  if (budget.remainingMs <= 0) return null;
  const started = Date.now();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(() => expired),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(null); }, budget.remainingMs);
        timer.unref();
      }),
    ]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
    budget.remainingMs -= Math.max(0, Date.now() - started);
  }
}

async function executableRealpath(path: string): Promise<string | null> {
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) return null;
    return await realpath(path);
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
    private readonly readExecutable: (path: string) => Promise<string | null> = executableRealpath,
  ) {}

  command(environment: NodeJS.ProcessEnv): string {
    return this.selection && this.selection.path === environment.PATH ? this.selection.command : "git";
  }

  prepare(environment: NodeJS.ProcessEnv, locateAppleGit: () => Promise<string>): Promise<void> {
    if (this.platform !== "darwin") return Promise.resolve();
    const path = environment.PATH;
    // Relative/empty entries can choose a different executable for each cwd.
    // Leave those invocations to their existing PATH semantics. Bound startup
    // filesystem discovery even when the inherited PATH is unusually large.
    if (!path || path.length > 16_384) return Promise.resolve();
    const entries = path.split(":");
    if (entries.length > 128 || entries.some(entry => !isAbsolute(entry))) return Promise.resolve();
    if (this.selection?.path === path) return this.selection.preparation;
    const selection = { path, command: "git", preparation: Promise.resolve() };
    this.selection = selection;
    selection.preparation = (async () => {
      // Share one filesystem budget; do not reset it for each PATH entry or
      // race away the separately bounded owned helper's cleanup once spawned.
      const budget = { remainingMs: FILESYSTEM_SELECTION_BUDGET_MS };
      const selected = await withinFilesystemBudget(budget, async expired => {
        for (const entry of entries) {
          const executable = await this.readExecutable(join(entry, "git"));
          if (expired()) return null;
          if (executable) return executable;
        }
        return null;
      });
      if (selected !== "/usr/bin/git") return;
      // xcrun applies the selected Xcode/toolchain policy. Its environment
      // is sanitized by the same privileged runner used for Git commands.
      const located = (await locateAppleGit()).trim();
      if (!isAbsolute(located) || /[\0\r\n]/u.test(located)) return;
      const executable = await withinFilesystemBudget(budget, () => this.readExecutable(located));
      if (executable && executable !== "/usr/bin/git") selection.command = executable;
    })();
    return selection.preparation;
  }
}
