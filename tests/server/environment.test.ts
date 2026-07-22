import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executableCandidates, providerEnvironment } from "../../src/server/environment";
import { portableNodeExecutable } from "../helpers/portable-provider-fixture";

const ENVIRONMENT_KEYS = ["APPDATA", "HOME", "LOCALAPPDATA", "PATH", "SHELL", "USERPROFILE", "ZDOTDIR"] as const;

describe.sequential("provider environment discovery", () => {
  const roots: string[] = [];
  const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-environment-"));
    roots.push(root);
    return root;
  }

  function executable(root: string, name: string): string {
    return portableNodeExecutable(root, name);
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
    const command = executable(shellBin, "login-shell-agent");
    const shell = join(home, "zsh");
    writeFileSync(
      shell,
      `#!/bin/sh\nPATH=${JSON.stringify(`${shellBin}${delimiter}/usr/bin${delimiter}/bin`)} INERTIA_LOGIN_SHELL_MARKER=ready /usr/bin/env -0\n`,
    );
    chmodSync(shell, 0o700);

    setEnvironment({ HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("login-shell-agent", environment, home);

    expect(environment.env.INERTIA_LOGIN_SHELL_MARKER).toBe("ready");
    expect(environment.pathEntries[0]).toBe(shellBin);
    expect(candidates).toEqual([realpathSync.native(command)]);
  });

  it("searches known per-user CLI directories when the shell PATH is minimal", async () => {
    const home = temporaryRoot();
    const localBin = process.platform === "win32" ? join(home, "npm") : join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const command = executable(localBin, "known-path-agent");

    setEnvironment({ APPDATA: home, HOME: home, PATH: home, SHELL: process.env.SHELL, USERPROFILE: home });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("known-path-agent", environment, home);

    expect(environment.pathEntries).toContain(localBin);
    expect(candidates).toEqual([realpathSync.native(command)]);
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
