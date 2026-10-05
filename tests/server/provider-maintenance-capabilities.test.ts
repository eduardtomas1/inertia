import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ProviderEnvironment } from "../../src/server/environment";
import {
  resolveProviderMaintenanceCapabilities,
  type ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";

const environment: ProviderEnvironment = {
  env: { PATH: "/tools" },
  pathEntries: ["/tools"],
};

function writableNpmInstallation(executable: string) {
  return {
    access: async () => undefined,
    realpath: async (path: string) => path.endsWith("/bin/codex") ? executable : path,
  };
}

function target(
  input: Partial<ProviderMaintenanceTarget> = {},
): ProviderMaintenanceTarget {
  return {
    providerId: "codex",
    executable: "/manual/codex",
    installedVersion: "1.0.0",
    installed: true,
    ...input,
  };
}

describe("provider maintenance capabilities", () => {
  it("keeps unknown Codex paths instructions-only without guessing npm", async () => {
    const loadEnvironment = vi.fn(async () => environment);
    const resolveExecutable = vi.fn(async () => ["/tools/npm"]);
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({ executable: "/home/user/bin/codex" }),
      {
        environment: loadEnvironment,
        executableCandidates: resolveExecutable,
      },
    );

    expect(capabilities).toMatchObject({
      providerId: "codex",
      installMethod: "manual",
      updateAvailability: "instructions-only",
      update: null,
      manualCommand: null,
      message: "Inertia could not tell how Codex was installed. Update it the way you installed it.",
    });
    expect(loadEnvironment).toHaveBeenCalledTimes(1);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)("uses npm only when Codex has proven npm-global provenance on %s", async (platform) => {
    const resolveExecutable = vi.fn(async (command: string) => (
      command === "/usr/local/bin/npm"
        ? ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"]
        : command === "/usr/local/bin/node" ? [command] : []
    ));
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/usr/local/lib/node_modules/@openai/codex/bin/codex",
      }),
      {
        ...writableNpmInstallation("/usr/local/lib/node_modules/@openai/codex/bin/codex"),
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform,
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "npm-global",
      updateAvailability: "available",
      update: {
        executable: "/usr/local/bin/node",
        args: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js", "install", "-g", "--prefix", "/usr/local", "@openai/codex@latest"],
        environmentPathPrefix: "/usr/local/bin",
        lockKey: "npm-global:/usr/local",
      },
      manualCommand: "npm install -g --prefix /usr/local @openai/codex@latest",
    });
    expect(resolveExecutable).toHaveBeenCalledWith(
      "/usr/local/bin/npm",
      environment,
    );
  });

  it.each(["linux", "darwin"] as const)("uses npm from the detected NVM version instead of an earlier system npm on %s", async (platform) => {
    const nvmRoot = "/home/user/.nvm/versions/node/v22.19.0";
    const desktopEnvironment: ProviderEnvironment = {
      env: { PATH: `/usr/bin:${nvmRoot}/bin` },
      pathEntries: ["/usr/bin", `${nvmRoot}/bin`],
    };
    const resolveExecutable = vi.fn(async (command: string) => {
      if (command === `${nvmRoot}/bin/npm`) {
        return [`${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`];
      }
      if (command === `${nvmRoot}/bin/node`) return [command];
      return command === "npm" ? ["/usr/share/nodejs/npm/bin/npm-cli.js"] : [];
    });
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: `${nvmRoot}/lib/node_modules/@openai/codex/bin/codex.js`,
      }),
      {
        ...writableNpmInstallation(`${nvmRoot}/lib/node_modules/@openai/codex/bin/codex.js`),
        environment: async () => desktopEnvironment,
        executableCandidates: resolveExecutable,
        platform,
      },
    );

    expect(capabilities.update).toMatchObject({
      executable: `${nvmRoot}/bin/node`,
      args: [`${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`, "install", "-g", "--prefix", nvmRoot, "@openai/codex@latest"],
      environmentPathPrefix: `${nvmRoot}/bin`,
    });
    expect(resolveExecutable).toHaveBeenCalledTimes(2);
    expect(resolveExecutable).not.toHaveBeenCalledWith(
      "npm",
      expect.anything(),
    );
  });

  it("keeps npm-installed Codex manual when its owning npm is unavailable", async () => {
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/home/user/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js",
      }),
      {
        ...writableNpmInstallation("/home/user/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js"),
        environment: async () => environment,
        executableCandidates: async () => [],
        platform: "linux",
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "npm-global",
      updateAvailability: "instructions-only",
      update: null,
    });
  });

  it.each(["/home/user/.local", "/usr/local"])(
    "binds a writable %s prefix to distro npm and its own Node with a minimal GUI PATH",
    async (prefix) => {
      const executable = `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`;
      const resolveExecutable = vi.fn(async (command: string) => {
        if (command === "npm") return ["/usr/share/nodejs/npm/bin/npm-cli.js"];
        return command === "/usr/bin/node" ? [command] : [];
      });
      const capabilities = await resolveProviderMaintenanceCapabilities(target({ executable }), {
        ...writableNpmInstallation(executable),
        environment: async () => ({ env: { PATH: "/usr/bin:/bin", NPM_CONFIG_PREFIX: "/unrelated" }, pathEntries: ["/usr/bin", "/bin"] }),
        executableCandidates: resolveExecutable,
        platform: "linux",
      });
      expect(capabilities.update).toMatchObject({
        executable: "/usr/bin/node",
        args: ["/usr/share/nodejs/npm/bin/npm-cli.js", "install", "-g", "--prefix", prefix, "@openai/codex@latest"],
        environmentPathPrefix: "/usr/bin",
      });
      expect(resolveExecutable.mock.calls.map(([command]) => command))
        .toEqual([`${prefix}/bin/npm`, "npm", "/usr/bin/node"]);
    },
  );

  it("explains a non-writable system prefix without offering an updater", async () => {
    const executable = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
    const resolveExecutable = vi.fn(async () => ["/usr/bin/npm"]);
    const capabilities = await resolveProviderMaintenanceCapabilities(target({ executable }), {
      ...writableNpmInstallation(executable),
      access: async () => { throw new Error("EACCES"); },
      environment: async () => environment,
      executableCandidates: resolveExecutable,
      platform: "linux",
    });
    expect(capabilities).toMatchObject({
      update: null,
      updateAvailability: "instructions-only",
      message: "Your account cannot write this installation.",
      manualCommand: "sudo npm install -g --prefix /usr/local @openai/codex@latest",
    });
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("allows a writable npm tree beneath root-owned macOS prefix parents", async () => {
    const executable = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
    const capabilities = await resolveProviderMaintenanceCapabilities(target({ executable }), {
      ...writableNpmInstallation(executable),
      access: async (path) => {
        if (path === "/usr/local" || path === "/usr/local/lib") throw new Error("EACCES");
      },
      environment: async () => environment,
      executableCandidates: async (command) => command === "/usr/local/bin/npm"
        ? ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"]
        : command === "/usr/local/bin/node" ? [command] : [],
      platform: "darwin",
    });
    expect(capabilities.update).toMatchObject({ executable: "/usr/local/bin/node" });
  });

  it.each(["/usr/share/nodejs/npm/bin/npm-cli.js", "/home/user/.asdf/shims/npm"])(
    "does not borrow an unrelated Node from PATH for %s",
    async (manager) => {
      const executable = "/home/user/.local/lib/node_modules/@openai/codex/bin/codex.js";
      const capabilities = await resolveProviderMaintenanceCapabilities(target({ executable }), {
        ...writableNpmInstallation(executable),
        environment: async () => environment,
        executableCandidates: async (command) => command === "npm" ? [manager] : command === "node" ? ["/unrelated/node"] : [],
        platform: "linux",
      });
      expect(capabilities).toMatchObject({ update: null, message: expect.stringContaining("pair npm") });
    },
  );

  it.each([
    ["/home/user/.asdf/shims/codex", "version-manager"],
    ["/home/user/.local/share/mise/shims/codex", "version-manager"],
    ["/home/user/.volta/bin/codex", "manual"],
    ["/usr/bin/codex", "system-package"],
  ] as const)("keeps an externally managed executable at %s manual", async (executable, installMethod) => {
    expect(await resolveProviderMaintenanceCapabilities(target({ executable }), {
      platform: "linux",
      environment: async () => environment,
    })).toMatchObject({ installMethod, update: null, updateAvailability: "instructions-only" });
  });

  it.skipIf(process.platform === "win32")("verifies the discovered symlink and rejects redirected directories or native vendor targets", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-npm-prefix-")));
    const executable = join(root, "lib/node_modules/@openai/codex/bin/codex.js");
    await mkdir(join(root, "lib/node_modules/@openai/codex/bin"), { recursive: true });
    await mkdir(join(root, "bin"));
    await writeFile(executable, "fixture", { mode: 0o755 });
    await symlink(executable, join(root, "bin/codex"));
    const dependencies = {
      environment: async () => environment,
      executableCandidates: async (command: string) => command === "npm" ? ["/usr/share/nodejs/npm/bin/npm-cli.js"] : command === "/usr/bin/node" ? [command] : [],
      platform: "linux" as const,
    };
    try {
      expect((await resolveProviderMaintenanceCapabilities(target({ executable }), dependencies)).update)
        .toMatchObject({ executable: "/usr/bin/node" });
      const nativeTarget = join(root, "lib/node_modules/@openai/codex/vendor/codex");
      expect((await resolveProviderMaintenanceCapabilities(target({ executable: nativeTarget }), dependencies)).update).toBeNull();
      await rm(join(root, "bin"), { recursive: true });
      await mkdir(join(root, "outside"));
      await symlink(executable, join(root, "outside/codex"));
      await symlink(join(root, "outside"), join(root, "bin"));
      expect(await resolveProviderMaintenanceCapabilities(target({ executable }), dependencies))
        .toMatchObject({ update: null, message: expect.stringContaining("could not verify") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not derive an updater from relative npm package paths", async () => {
    const resolveExecutable = vi.fn(async () => ["/tools/npm"]);
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "relative/lib/node_modules/@openai/codex/bin/codex.js",
      }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform: "linux",
      },
    );

    expect(capabilities).toMatchObject({
      updateAvailability: "instructions-only",
      update: null,
    });
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("does not treat an arbitrary Windows codex.cmd as an npm shim", async () => {
    const resolveExecutable = vi.fn(async (command: string) => [command]);
    expect(await resolveProviderMaintenanceCapabilities(
      target({ executable: "C:\\Tools\\codex.cmd" }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform: "win32",
      },
    )).toMatchObject({ installMethod: "manual", update: null });
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("binds a Windows Codex shim to npm in the same global directory", async () => {
    const npmDirectory = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
    const resolveExecutable = vi.fn(async (command: string) => (
      command === `${npmDirectory}\\npm.cmd` ? [command] : []
    ));
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({ executable: `${npmDirectory}\\codex.cmd` }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform: "win32",
      },
    );

    expect(capabilities.update).toMatchObject({
      executable: `${npmDirectory}\\npm.cmd`,
      environmentPathPrefix: npmDirectory,
    });
  });

  it.each([
    ["Caskroom", ["upgrade", "--cask", "codex"]],
    ["Cellar", ["upgrade", "codex"]],
  ] as const)("upgrades a %s Codex with the prefix's own brew", async (kind, args) => {
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({ executable: `/opt/homebrew/${kind}/codex/1.2.3/bin/codex` }),
      {
        platform: "darwin",
        environment: async () => environment,
        lstat: async (path) => {
          if (path !== "/opt/homebrew/bin/brew") throw new Error("ENOENT");
          return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
        },
        realpath: async (path) => path,
        access: async () => undefined,
      },
    );

    expect(capabilities.update).toEqual({
      executable: "/opt/homebrew/bin/brew",
      args,
      lockKey: "homebrew:/opt/homebrew",
      installMethod: "homebrew",
      label: "Update Codex with Homebrew",
    });
    expect(capabilities.manualCommand).toBe(["brew", ...args].join(" "));
  });

  it("falls back to instructions when the proven manager is unavailable", async () => {
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/opt/homebrew/Caskroom/codex/1.2.3/codex",
      }),
      {
        platform: "darwin",
        environment: async () => environment,
        lstat: async () => { throw new Error("ENOENT"); },
        realpath: async (path) => path,
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "homebrew",
      updateAvailability: "instructions-only",
      update: null,
      manualCommand: "brew upgrade --cask codex",
    });
  });

  it.each([
    ["claude", "/exact/claude"],
    ["cursor", "/exact/cursor-agent"],
    ["opencode", "/exact/opencode"],
    ["kimi", "/exact/kimi"],
    ["antigravity", "/exact/agy"],
  ] as const)(
    "never runs a native %s updater for an unproven installation",
    async (providerId, executable) => {
      const capabilities = await resolveProviderMaintenanceCapabilities(
        target({ providerId, executable }),
        { platform: "linux", environment: async () => environment },
      );
      expect(capabilities).toMatchObject({
        installMethod: "manual",
        updateAvailability: "instructions-only",
        update: null,
        manualCommand: null,
      });
      expect(capabilities.message).toMatch(/^Inertia could not tell how /u);
    },
  );
});
