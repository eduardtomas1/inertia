import { describe, expect, it, vi } from "vitest";

import type { ProviderEnvironment } from "../../src/server/environment";
import {
  codexInstallMethodFromPath,
  geminiInstallMethodFromPath,
  resolveProviderMaintenanceCapabilities,
  type ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";

const environment: ProviderEnvironment = {
  env: { PATH: "/tools" },
  pathEntries: ["/tools"],
};

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
    });
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("uses npm only when Codex has proven npm-global provenance", async () => {
    const resolveExecutable = vi.fn(async (command: string) => (
      command === "/usr/local/bin/npm"
        ? ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"]
        : []
    ));
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/usr/local/lib/node_modules/@openai/codex/bin/codex",
      }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform: "linux",
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "npm-global",
      updateAvailability: "available",
      update: {
        executable: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        args: ["install", "-g", "@openai/codex@latest"],
        environmentPathPrefix: "/usr/local/bin",
        lockKey: "package-manager:npm-global",
      },
    });
    expect(resolveExecutable).toHaveBeenCalledWith(
      "/usr/local/bin/npm",
      environment,
    );
  });

  it("uses npm from the detected NVM version instead of an earlier system npm", async () => {
    const nvmRoot = "/home/user/.nvm/versions/node/v22.19.0";
    const desktopEnvironment: ProviderEnvironment = {
      env: { PATH: `/usr/bin:${nvmRoot}/bin` },
      pathEntries: ["/usr/bin", `${nvmRoot}/bin`],
    };
    const resolveExecutable = vi.fn(async (command: string) => {
      if (command === `${nvmRoot}/bin/npm`) {
        return [`${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`];
      }
      return command === "npm" ? ["/usr/share/nodejs/npm/bin/npm-cli.js"] : [];
    });
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: `${nvmRoot}/lib/node_modules/@openai/codex/bin/codex.js`,
      }),
      {
        environment: async () => desktopEnvironment,
        executableCandidates: resolveExecutable,
        platform: "linux",
      },
    );

    expect(capabilities.update).toMatchObject({
      executable: `${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`,
      environmentPathPrefix: `${nvmRoot}/bin`,
    });
    expect(resolveExecutable).toHaveBeenCalledTimes(1);
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

  it("recognizes the standard Windows npm shim location", () => {
    expect(codexInstallMethodFromPath(
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd",
    )).toBe("npm-global");
    expect(codexInstallMethodFromPath(
      "C:\\Tools\\codex.cmd",
    )).toBe("manual");
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

  it("uses Homebrew only for a canonical Cellar or Caskroom path", async () => {
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/opt/homebrew/Caskroom/codex/1.2.3/codex",
      }),
      {
        environment: async () => environment,
        executableCandidates: async (command) => (
          command === "brew" ? ["/opt/homebrew/bin/brew"] : []
        ),
      },
    );

    expect(capabilities.update).toEqual({
      executable: "/opt/homebrew/bin/brew",
      args: ["upgrade", "--cask", "codex"],
      lockKey: "package-manager:homebrew",
      installMethod: "homebrew",
      label: "Update Codex with Homebrew",
    });
  });

  it("falls back to instructions when the proven manager is unavailable", async () => {
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        executable: "/opt/homebrew/Caskroom/codex/1.2.3/codex",
      }),
      {
        environment: async () => environment,
        executableCandidates: async () => [],
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "homebrew",
      updateAvailability: "instructions-only",
      update: null,
    });
  });

  it("keeps arbitrary Gemini paths instructions-only without guessing ownership", async () => {
    const loadEnvironment = vi.fn(async () => environment);
    const resolveExecutable = vi.fn(async () => ["/tools/npm"]);
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        providerId: "gemini",
        executable: "/home/user/bin/gemini",
      }),
      {
        environment: loadEnvironment,
        executableCandidates: resolveExecutable,
      },
    );

    expect(capabilities).toMatchObject({
      providerId: "gemini",
      packageName: "@google/gemini-cli",
      installMethod: "manual",
      updateAvailability: "instructions-only",
      update: null,
    });
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("does not update a project-local Gemini package with an unrelated global npm", async () => {
    const loadEnvironment = vi.fn(async () => environment);
    const resolveExecutable = vi.fn(async () => ["/usr/bin/npm"]);
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        providerId: "gemini",
        executable:
          "/work/project/node_modules/@google/gemini-cli/dist/index.js",
      }),
      {
        environment: loadEnvironment,
        executableCandidates: resolveExecutable,
        platform: "linux",
      },
    );

    expect(capabilities).toMatchObject({
      installMethod: "npm-global",
      updateAvailability: "instructions-only",
      update: null,
    });
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("updates Gemini through the npm that owns its selected NVM installation", async () => {
    const nvmRoot = "/home/user/.nvm/versions/node/v22.19.0";
    const desktopEnvironment: ProviderEnvironment = {
      env: { PATH: `/usr/bin:${nvmRoot}/bin` },
      pathEntries: ["/usr/bin", `${nvmRoot}/bin`],
    };
    const resolveExecutable = vi.fn(async (command: string) =>
      command === `${nvmRoot}/bin/npm`
        ? [`${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`]
        : [],
    );
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        providerId: "gemini",
        executable: `${nvmRoot}/lib/node_modules/@google/gemini-cli/dist/index.js`,
      }),
      {
        environment: async () => desktopEnvironment,
        executableCandidates: resolveExecutable,
        platform: "linux",
      },
    );

    expect(capabilities).toMatchObject({
      providerId: "gemini",
      packageName: "@google/gemini-cli",
      installMethod: "npm-global",
      updateAvailability: "available",
      update: {
        executable: `${nvmRoot}/lib/node_modules/npm/bin/npm-cli.js`,
        args: ["install", "-g", "@google/gemini-cli@latest"],
        environmentPathPrefix: `${nvmRoot}/bin`,
        lockKey: "package-manager:npm-global",
        label: "Update Gemini CLI with npm",
      },
    });
    expect(resolveExecutable).toHaveBeenCalledTimes(1);
    expect(resolveExecutable).toHaveBeenCalledWith(
      `${nvmRoot}/bin/npm`,
      desktopEnvironment,
    );
  });

  it("binds the standard Windows Gemini shim to npm in the same directory", async () => {
    const npmDirectory = "C:\\Users\\Ada\\AppData\\Roaming\\npm";
    expect(geminiInstallMethodFromPath(`${npmDirectory}\\gemini.cmd`)).toBe(
      "npm-global",
    );
    expect(geminiInstallMethodFromPath("C:\\Tools\\gemini.cmd")).toBe("manual");

    const resolveExecutable = vi.fn(async (command: string) =>
      command === `${npmDirectory}\\npm.cmd` ? [command] : [],
    );
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        providerId: "gemini",
        executable: `${npmDirectory}\\gemini.cmd`,
      }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
        platform: "win32",
      },
    );

    expect(capabilities.update).toMatchObject({
      executable: `${npmDirectory}\\npm.cmd`,
      args: ["install", "-g", "@google/gemini-cli@latest"],
      environmentPathPrefix: npmDirectory,
    });
  });

  it("updates canonical Homebrew Gemini installations with the owning formula", async () => {
    const resolveExecutable = vi.fn(async (command: string) =>
      command === "/opt/homebrew/bin/brew" ? [command] : [],
    );
    const capabilities = await resolveProviderMaintenanceCapabilities(
      target({
        providerId: "gemini",
        executable: "/opt/homebrew/Cellar/gemini-cli/0.58.0/bin/gemini",
      }),
      {
        environment: async () => environment,
        executableCandidates: resolveExecutable,
      },
    );

    expect(capabilities.update).toEqual({
      executable: "/opt/homebrew/bin/brew",
      args: ["upgrade", "gemini-cli"],
      lockKey: "package-manager:homebrew",
      installMethod: "homebrew",
      label: "Update Gemini CLI with Homebrew",
    });
    expect(resolveExecutable).toHaveBeenCalledWith(
      "/opt/homebrew/bin/brew",
      environment,
    );
  });

  it.each([
    ["claude", "/exact/claude", ["update"]],
    ["cursor", "/exact/cursor-agent", ["update"]],
    ["opencode", "/exact/opencode", ["upgrade"]],
  ] as const)(
    "uses the exact detected executable for the documented %s self-update",
    async (providerId, executable, args) => {
      const capabilities = await resolveProviderMaintenanceCapabilities(
        target({ providerId, executable }),
      );
      expect(capabilities.update).toMatchObject({
        executable,
        args,
        installMethod: "provider-managed",
      });
    },
  );

  it("keeps Kimi's interactive upgrader instructions-only", async () => {
    await expect(resolveProviderMaintenanceCapabilities(target({
      providerId: "kimi",
      executable: "/exact/kimi",
    }))).resolves.toMatchObject({
      providerId: "kimi",
      packageName: "@moonshot-ai/kimi-code",
      installMethod: "provider-managed",
      updateAvailability: "instructions-only",
      update: null,
    });
  });
});
