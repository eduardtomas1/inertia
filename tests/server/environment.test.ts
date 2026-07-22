import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executableCandidates, providerEnvironment } from "../../src/server/environment";

const ENVIRONMENT_KEYS = ["HOME", "PATH", "SHELL", "ZDOTDIR"] as const;

describe.sequential("provider environment discovery", () => {
  const roots: string[] = [];
  const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-environment-"));
    roots.push(root);
    return root;
  }

  function executable(path: string): void {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o700);
  }

  function setEnvironment(values: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>): void {
    for (const key of ENVIRONMENT_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  afterEach(async () => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
    await providerEnvironment(true);
  });

  it.skipIf(process.platform === "win32")("recovers commands exported by the login shell from a stripped GUI PATH", async () => {
    const home = temporaryRoot();
    const shellBin = join(home, "shell-bin");
    mkdirSync(shellBin, { recursive: true });
    const command = join(shellBin, "login-shell-agent");
    executable(command);
    writeFileSync(join(home, ".zprofile"), `export PATH=${JSON.stringify(`${shellBin}${delimiter}/usr/bin${delimiter}/bin`)}\n`);
    writeFileSync(join(home, ".zshrc"), "\n");

    setEnvironment({ HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("login-shell-agent", environment, home);

    expect(environment.pathEntries[0]).toBe(shellBin);
    expect(candidates).toEqual([realpathSync(command)]);
  });

  it.skipIf(process.platform === "win32")("searches known per-user CLI directories when the shell PATH is minimal", async () => {
    const home = temporaryRoot();
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const command = join(localBin, "known-path-agent");
    executable(command);
    writeFileSync(join(home, ".profile"), "export PATH=/usr/bin:/bin\n");

    setEnvironment({ HOME: home, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("known-path-agent", environment, home);

    expect(environment.pathEntries).toContain(localBin);
    expect(candidates).toEqual([realpathSync(command)]);
  });

  it.skipIf(process.platform === "win32")("ignores non-executable and malformed command candidates", async () => {
    const root = temporaryRoot();
    const nonExecutable = join(root, "not-executable");
    writeFileSync(nonExecutable, "plain text");
    const environment = { env: { PATH: root }, pathEntries: [root] };

    await expect(executableCandidates("not-executable", environment, root)).resolves.toEqual([]);
    await expect(executableCandidates("bad\0command", environment, root)).resolves.toEqual([]);
  });
});
