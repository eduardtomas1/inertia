import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderEnvironment } from "../../src/server/environment";
import {
  resolveProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilityDependencies,
} from "../../src/server/provider/maintenance-capabilities";
import type { ProviderMaintenanceProviderId } from "../../src/shared/provider-maintenance";

const posixIt = it.skipIf(process.platform === "win32");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function layout(): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-install-source-")));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

async function file(path: string, content = "#!/bin/sh\nexit 0\n"): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o755 });
  return path;
}

async function link(target: string, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
  return path;
}

function environment(
  pathEntries: string[],
  env: NodeJS.ProcessEnv = {},
): ProviderEnvironment {
  return { env: { PATH: pathEntries.join(":"), ...env }, pathEntries };
}

async function classify(
  providerId: ProviderMaintenanceProviderId,
  executable: string,
  home: string,
  providerEnvironment: ProviderEnvironment,
  dependencies: ProviderMaintenanceCapabilityDependencies = {},
) {
  return await resolveProviderMaintenanceCapabilities({
    providerId,
    executable,
    installedVersion: "1.0.0",
    installed: true,
  }, {
    home,
    platform: process.platform === "darwin" ? "darwin" : "linux",
    environment: async () => providerEnvironment,
    ...dependencies,
  });
}

async function npmPrefix(prefix: string): Promise<void> {
  const cli = await file(join(prefix, "lib/node_modules/npm/bin/npm-cli.js"));
  await link(cli, join(prefix, "bin/npm"));
  await file(join(prefix, "bin/node"));
}

async function npmPackage(
  prefix: string,
  packageName: string,
  command: string,
): Promise<string> {
  const entry = await file(join(prefix, "lib/node_modules", packageName, "bin", `${command}.js`));
  await link(entry, join(prefix, "bin", command));
  return entry;
}

const NPM_PACKAGES = [
  ["codex", "@openai/codex", "codex", ["@openai/codex@latest"]],
  ["claude", "@anthropic-ai/claude-code", "claude", ["--allow-scripts=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@latest"]],
  ["kimi", "@moonshot-ai/kimi-code", "kimi", ["--allow-scripts=@moonshot-ai/kimi-code", "--allow-scripts=node-pty", "@moonshot-ai/kimi-code@latest"]],
  ["opencode", "opencode-ai", "opencode", ["--allow-scripts=opencode-ai", "opencode-ai@1"]],
] as const;

describe("provider install source classification", () => {
  posixIt.each(NPM_PACKAGES)(
    "updates %s in a user npm prefix with that prefix's own npm and Node",
    async (providerId, packageName, command, tail) => {
      const { home } = await layout();
      const prefix = join(home, ".npm-global");
      await npmPrefix(prefix);
      const executable = await npmPackage(prefix, packageName, command);
      const capabilities = await classify(
        providerId,
        executable,
        home,
        environment([join(prefix, "bin")]),
      );
      expect(capabilities).toMatchObject({
        installMethod: "npm-global",
        updateAvailability: "available",
        manualCommand: ["npm install -g --prefix ~/.npm-global", ...tail].join(" "),
      });
      expect(capabilities.update).toEqual({
        executable: join(prefix, "bin/node"),
        args: [join(prefix, "lib/node_modules/npm/bin/npm-cli.js"), "install", "-g", "--prefix", prefix, ...tail],
        environmentPathPrefix: join(prefix, "bin"),
        lockKey: `npm-global:${prefix}`,
        installMethod: "npm-global",
        label: expect.stringMatching(/ with npm$/u),
        ...(providerId === "opencode"
          ? { versionPin: { major: 1, argumentIndex: null, command: null } }
          : {}),
      });
    },
  );

  posixIt.each([
    ["nvm", ".nvm/versions/node/v22.19.0"],
    ["fnm", ".local/share/fnm/node-versions/v22.19.0/installation"],
  ])("treats a %s Node prefix as an npm prefix", async (_manager, relative) => {
    const { home } = await layout();
    const prefix = join(home, relative);
    await npmPrefix(prefix);
    const executable = await npmPackage(prefix, "@openai/codex", "codex");
    const capabilities = await classify("codex", executable, home, environment([join(prefix, "bin")]));
    expect(capabilities.manualCommand).toBe(`npm install -g --prefix ~/${relative} @openai/codex@latest`);
    expect(capabilities.update).toMatchObject({
      executable: join(prefix, "bin/node"),
      lockKey: `npm-global:${prefix}`,
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a prefix the account cannot write manual without inventing a command",
    async () => {
      const { home } = await layout();
      const prefix = join(home, "shared-prefix");
      await npmPrefix(prefix);
      const executable = await npmPackage(prefix, "@openai/codex", "codex");
      await chmod(join(prefix, "lib/node_modules"), 0o555);
      try {
        const capabilities = await classify("codex", executable, home, environment([join(prefix, "bin")]));
        expect(capabilities).toMatchObject({
          installMethod: "npm-global",
          updateAvailability: "instructions-only",
          update: null,
          message: "Your account cannot write this installation.",
          manualCommand: null,
        });
      } finally {
        await chmod(join(prefix, "lib/node_modules"), 0o755);
      }
    },
  );

  it.each([
    ["/usr", "sudo npm install -g --prefix /usr @openai/codex@latest"],
    ["/usr/local", "sudo npm install -g --prefix /usr/local @openai/codex@latest"],
    ["/opt/local", "sudo npm install -g --prefix /opt/local @openai/codex@latest"],
    ["/opt/homebrew", null],
    ["/home/linuxbrew/.linuxbrew", null],
  ] as const)("offers sudo only for a root-owned system npm prefix such as %s", async (prefix, manualCommand) => {
    const executable = `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`;
    const capabilities = await classify("codex", executable, "/home/ada", environment([`${prefix}/bin`]), {
      platform: "linux",
      lstat: async () => { throw new Error("not used"); },
      realpath: async (path) => path === `${prefix}/bin/codex` ? executable : path,
      access: async () => { throw new Error("EACCES"); },
    });
    expect(capabilities).toMatchObject({
      installMethod: "npm-global",
      update: null,
      message: "Your account cannot write this installation.",
      manualCommand,
    });
  });

  posixIt("updates a Volta package through Volta when its image proves ownership", async () => {
    const { home } = await layout();
    const voltaHome = join(home, ".volta");
    const shim = await file(join(voltaHome, "bin/volta-shim"));
    const executable = await link(shim, join(voltaHome, "bin/codex"));
    await file(join(voltaHome, "bin/volta"));
    await mkdir(join(voltaHome, "tools/image/packages/@openai/codex"), { recursive: true });
    const capabilities = await classify("codex", executable, home, environment([join(voltaHome, "bin")]));
    expect(capabilities).toMatchObject({
      installMethod: "volta",
      manualCommand: "volta install @openai/codex@latest",
      update: {
        executable: join(voltaHome, "bin/volta"),
        args: ["install", "@openai/codex@latest"],
        environment: { VOLTA_HOME: voltaHome },
        lockKey: `volta:${voltaHome}`,
      },
    });
  });

  posixIt("updates a pnpm global shim with the pnpm in PNPM_HOME", async () => {
    const { home } = await layout();
    const pnpmHome = join(home, ".local/share/pnpm");
    await mkdir(join(pnpmHome, "global/5/node_modules/@anthropic-ai/claude-code"), { recursive: true });
    await file(join(pnpmHome, "pnpm"));
    const executable = await file(join(pnpmHome, "claude"), [
      "#!/bin/sh",
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'exec node  "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
      "",
    ].join("\n"));
    const capabilities = await classify("claude", executable, home, environment([pnpmHome], { PNPM_HOME: pnpmHome }));
    expect(capabilities).toMatchObject({
      installMethod: "pnpm-global",
      manualCommand: "pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
      update: {
        executable: join(pnpmHome, "pnpm"),
        args: ["add", "-g", "--allow-build=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@latest"],
        environment: { PNPM_HOME: pnpmHome },
        lockKey: `pnpm-global:${pnpmHome}`,
      },
    });
  });

  posixIt("does not trust a PNPM_HOME script that names another package", async () => {
    const { home } = await layout();
    const pnpmHome = join(home, "pnpm");
    await mkdir(join(pnpmHome, "global/5/node_modules/@openai/codex"), { recursive: true });
    await file(join(pnpmHome, "pnpm"));
    const executable = await file(
      join(pnpmHome, "codex"),
      '#!/bin/sh\nexec node "$basedir/global/5/node_modules/other/cli.js" "$@"\n',
    );
    const capabilities = await classify("codex", executable, home, environment([pnpmHome], { PNPM_HOME: pnpmHome }));
    expect(capabilities).toMatchObject({ installMethod: "manual", update: null });
  });

  posixIt("updates a bun global package with bun and trusts Claude's install script", async () => {
    const { home } = await layout();
    const bunHome = join(home, ".bun");
    const entry = await file(join(bunHome, "install/global/node_modules/@anthropic-ai/claude-code/cli.js"));
    const executable = await realpath(await link(entry, join(bunHome, "bin/claude")));
    await file(join(bunHome, "bin/bun"));
    const capabilities = await classify("claude", executable, home, environment([join(bunHome, "bin")]));
    expect(capabilities).toMatchObject({
      installMethod: "bun-global",
      manualCommand: "bun add -g --trust @anthropic-ai/claude-code@latest",
      update: {
        executable: join(bunHome, "bin/bun"),
        args: ["add", "-g", "--trust", "@anthropic-ai/claude-code@latest"],
        environment: { BUN_INSTALL: bunHome },
        lockKey: `bun-global:${bunHome}`,
      },
    });
  });

  posixIt("updates a yarn classic global package with yarn from PATH", async () => {
    const { root, home } = await layout();
    const globalDirectory = join(home, ".config/yarn/global");
    const entry = await file(join(globalDirectory, "node_modules/@openai/codex/bin/codex.js"));
    const executable = await realpath(await link(entry, join(home, ".yarn/bin/codex")));
    const yarn = await file(join(root, "tools/yarn"));
    const capabilities = await classify(
      "codex",
      executable,
      home,
      environment([join(home, ".yarn/bin"), join(root, "tools")]),
    );
    expect(capabilities).toMatchObject({
      installMethod: "yarn-global",
      manualCommand: "yarn global add @openai/codex@latest",
      update: {
        executable: yarn,
        args: ["global", "add", "@openai/codex@latest"],
        lockKey: `yarn-global:${globalDirectory}`,
      },
    });
  });

  posixIt.each([
    ["codex", "Cellar/codex/0.159.0/bin/codex", ["upgrade", "codex"], undefined],
    ["codex", "Caskroom/codex/0.159.0/bin/codex", ["upgrade", "--cask", "codex"], undefined],
    ["claude", "Caskroom/claude-code/2.1.98/claude", ["upgrade", "--cask", "claude-code"], undefined],
    ["opencode", "Cellar/opencode/1.0.0/bin/opencode", ["upgrade", "opencode"], { major: 1, argumentIndex: null, command: null }],
  ] as const)("upgrades %s at %s with the keg's own brew", async (providerId, relative, args, versionPin) => {
    const { root, home } = await layout();
    const prefix = join(root, "linuxbrew");
    const brew = await file(join(prefix, "Homebrew/bin/brew"), `#!/bin/sh\n[ "$1" = --prefix ] && echo ${prefix}\n`);
    await link(brew, join(prefix, "bin/brew"));
    const executable = await file(join(prefix, relative));
    const capabilities = await classify(providerId, executable, home, environment([join(prefix, "bin")]));
    expect(capabilities).toMatchObject({
      installMethod: "homebrew",
      manualCommand: ["brew", ...args].join(" "),
    });
    expect(capabilities.homebrew).toEqual({
      brew: join(prefix, "bin/brew"),
      name: args[args.length - 1],
      cask: (args as readonly string[]).includes("--cask"),
    });
    expect(capabilities.update).toEqual({
      executable: join(prefix, "bin/brew"),
      args,
      lockKey: `homebrew:${prefix}`,
      installMethod: "homebrew",
      label: expect.stringMatching(/ with Homebrew$/u),
      ...(versionPin ? { versionPin } : {}),
    });
  });

  posixIt("keeps a keg manual when its prefix has no brew of its own", async () => {
    const { root, home } = await layout();
    const executable = await file(join(root, "brew/Cellar/codex/1.0.0/bin/codex"));
    expect(await classify("codex", executable, home, environment([join(root, "brew/bin")])))
      .toMatchObject({ installMethod: "homebrew", update: null, manualCommand: "brew upgrade codex" });
  });

  posixIt("runs the Codex standalone updater through its link with the configured CODEX_HOME", async () => {
    const { root, home } = await layout();
    const codexHome = join(root, "codex-home");
    const release = await file(join(codexHome, "packages/standalone/releases/0.160.0/codex"));
    const hit = await link(release, join(home, ".local/bin/codex"));
    const capabilities = await classify("codex", release, home, environment([join(home, ".local/bin")], { CODEX_HOME: codexHome }));
    expect(capabilities).toMatchObject({
      installMethod: "provider-managed",
      manualCommand: "codex update",
      update: {
        executable: hit,
        args: ["update"],
        environment: { CODEX_HOME: codexHome },
        lockKey: "native:codex",
      },
    });
  });

  posixIt.each([
    ["claude", ".local/share/claude/versions/2.1.280", ".local/bin/claude", ["update"], "claude update"],
    ["cursor", ".local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent", ".local/bin/cursor-agent", ["update"], "cursor-agent update"],
    ["antigravity", ".local/bin/agy", null, ["update"], "agy update"],
  ] as const)("runs the %s vendor updater for its installer layout", async (providerId, installed, linked, args, manualCommand) => {
    const { home } = await layout();
    const executable = await file(join(home, installed));
    const hit = linked ? await link(executable, join(home, linked)) : executable;
    const capabilities = await classify(providerId, executable, home, environment([join(home, ".local/bin")]));
    expect(capabilities).toMatchObject({
      installMethod: "provider-managed",
      manualCommand,
      update: { executable: hit, args, lockKey: `native:${providerId}` },
    });
    expect(capabilities.update?.environment).toBeUndefined();
  });

  posixIt("pins the OpenCode curl updater to 1.x", async () => {
    const { home } = await layout();
    const executable = await file(join(home, ".opencode/bin/opencode"));
    const capabilities = await classify("opencode", executable, home, environment([join(home, ".opencode/bin")]));
    expect(capabilities).toMatchObject({
      installMethod: "provider-managed",
      manualCommand: null,
      update: {
        executable,
        args: ["upgrade", "--method", "curl"],
        versionPin: { major: 1, argumentIndex: 1, command: "opencode" },
        lockKey: "native:opencode",
      },
    });
  });

  it("names the snap behind a snap alias", async () => {
    const capabilities = await classify("codex", "/snap/bin/codex", "/home/ada", environment(["/snap/bin"]), {
      platform: "linux",
      realpath: async (path) => path === "/snap/bin/codex" ? "/usr/bin/snap" : path,
      readlink: async (path) => path === "/snap/bin/codex" ? "openai-codex.codex" : "/usr/bin/snap",
    });
    expect(capabilities).toMatchObject({ installMethod: "snap", manualCommand: "sudo snap refresh openai-codex" });
  });

  posixIt("sends the retired kimi-cli uv tool to a manual Kimi Code install", async () => {
    const { root, home } = await layout();
    const toolDirectory = join(home, ".local/share/uv/tools");
    const executable = await file(join(toolDirectory, "kimi-cli/bin/kimi"));
    await link(executable, join(home, ".local/bin/kimi"));
    await file(join(root, "tools/uv"));
    const capabilities = await classify("kimi", executable, home, environment([join(home, ".local/bin"), join(root, "tools")]));
    expect(capabilities).toMatchObject({
      installMethod: "uv-tool",
      update: null,
      manualCommand: "npm install -g @moonshot-ai/kimi-code",
    });
  });

  it("runs the Claude installer's updater for its Windows binary", async () => {
    const executable = "C:\\Users\\Ada\\.local\\bin\\claude.exe";
    const capabilities = await classify("claude", executable, "C:\\Users\\Ada", { env: {}, pathEntries: [] }, {
      platform: "win32",
      realpath: async (path) => path,
    });
    expect(capabilities.update).toMatchObject({ args: ["update"], lockKey: "native:claude" });
  });

  it("names the snap to refresh for a snap command", async () => {
    const capabilities = await classify("codex", "/snap/bin/codex", "/home/ada", environment(["/snap/bin"]), {
      platform: "linux",
      realpath: async (path) => path === "/snap/bin/codex" ? "/usr/bin/snap" : path,
    });
    expect(capabilities).toMatchObject({
      installMethod: "snap",
      update: null,
      message: "Snap manages this installation.",
      manualCommand: "sudo snap refresh codex",
    });
  });

  posixIt("names the mise npm tool and refuses a bare mise shim", async () => {
    const { root, home } = await layout();
    const installed = await file(join(home, ".local/share/mise/installs/npm-openai-codex/0.160.0/lib/node_modules/@openai/codex/bin/codex.js"));
    expect(await classify("codex", installed, home, environment([])))
      .toMatchObject({ installMethod: "version-manager", update: null, manualCommand: "mise upgrade npm:@openai/codex" });
    const mise = await file(join(root, "bin/mise"));
    const shim = await link(mise, join(home, ".local/share/mise/shims/codex"));
    expect(await classify("codex", shim, home, environment([join(home, ".local/share/mise/shims")])))
      .toMatchObject({ installMethod: "version-manager", update: null, manualCommand: null });
  });

  it("leaves a distribution package to the system package manager", async () => {
    expect(await classify("opencode", "/usr/bin/opencode", "/home/ada", environment(["/usr/bin"]), {
      platform: "linux",
      realpath: async (path) => path,
    })).toMatchObject({ installMethod: "system-package", update: null, manualCommand: null });
  });

  posixIt.each([
    ["claude", "bin/claude"],
    ["claude", ".local/bin/claude"],
    ["codex", "bin/codex"],
    ["cursor", "Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
    ["codex", "project/node_modules/@openai/codex/bin/codex.js"],
    ["kimi", "project/node_modules/.bin/kimi"],
  ] as const)("never runs a native updater for an unproven %s at %s", async (providerId, relative) => {
    const { home } = await layout();
    const executable = await file(join(home, relative));
    const capabilities = await classify(providerId, executable, home, environment([dirname(executable)]));
    expect(capabilities).toMatchObject({
      installMethod: "manual",
      updateAvailability: "instructions-only",
      update: null,
      manualCommand: null,
    });
    expect(capabilities.message).toMatch(/^Inertia could not tell /u);
  });
});
