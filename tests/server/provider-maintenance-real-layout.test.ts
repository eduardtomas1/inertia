import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderEnvironment } from "../../src/server/environment";
import { providerInstallationIdentity } from "../../src/server/provider/installation-lease";
import {
  resolveProviderMaintenanceCapabilities,
  type ProviderMaintenanceTarget,
} from "../../src/server/provider/maintenance-capabilities";
import { ProviderMaintenanceController } from "../../src/server/provider/maintenance-controller";
import { ProviderLatestVersionCache } from "../../src/server/provider/maintenance-latest";
import { runProviderMaintenanceAction } from "../../src/server/provider/maintenance-runner";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../src/shared/provider-maintenance";
import { providerMaintenanceJournalTestDouble } from "../support/provider-maintenance-journal";

const nodeBin = dirname(process.execPath);
const npmCli = join(dirname(nodeBin), "lib/node_modules/npm/bin/npm-cli.js");
const posixIt = it.skipIf(process.platform === "win32");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function file(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o755 });
  return path;
}

async function link(target: string, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
  return path;
}

async function packageJson(path: string, name: string, version: string): Promise<void> {
  await file(path, `${JSON.stringify({ name, version })}\n`);
}

async function versionOf(path: string): Promise<string> {
  return (JSON.parse(await readFile(path, "utf8")) as { version: string }).version;
}

async function fakeManager(path: string, record: string, effect: string): Promise<string> {
  return await file(path, [
    `#!${process.execPath}`,
    "const fs = require(\"node:fs\");",
    "const pick = [\"PNPM_HOME\", \"BUN_INSTALL\", \"VOLTA_HOME\", \"CODEX_HOME\", \"OPENAI_API_KEY\", \"CI\", \"HOMEBREW_NO_AUTO_UPDATE\"];",
    "const env = Object.fromEntries(pick.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));",
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env }) + "\\n");`,
    effect,
    "",
  ].join("\n"));
}

function bump(path: string): string {
  return [
    `const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path)}, "utf8"));`,
    "manifest.version = \"1.0.1\";",
    `fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify(manifest));`,
  ].join("\n");
}

async function records(path: string): Promise<Array<{ argv: string[]; env: Record<string, string> }>> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function layout(): Promise<{ root: string; home: string; record: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-maintenance-layout-")));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  return { root, home, record: join(root, "record.jsonl") };
}

interface UpdateScenario {
  providerId: ProviderMaintenanceProviderId;
  home: string;
  pathEntries: string[];
  executable: () => Promise<string>;
  version: () => Promise<string>;
  packageSpec?: string;
  replacementBoundary?: string;
  env?: NodeJS.ProcessEnv;
}

async function runUpdate(scenario: UpdateScenario) {
  const environment: ProviderEnvironment = {
    env: {
      PATH: [...scenario.pathEntries, nodeBin, "/usr/bin", "/bin"].join(":"),
      HOME: scenario.home,
      OPENAI_API_KEY: "must-not-reach-the-updater",
      ...scenario.env,
    },
    pathEntries: [...scenario.pathEntries, nodeBin],
  };
  const target = async (): Promise<ProviderMaintenanceTarget> => ({
    providerId: scenario.providerId,
    executable: await scenario.executable(),
    installedVersion: await scenario.version(),
    installed: true,
  });
  let current = await target();
  const operations: ProviderMaintenanceOperation[] = [];
  const controller = new ProviderMaintenanceController({
    maintenanceJournal: providerMaintenanceJournalTestDouble(),
    target: () => current,
    refreshTarget: async () => {
      current = await target();
      return current;
    },
    latestVersions: new ProviderLatestVersionCache({
      fetch: async () => new Response(JSON.stringify({ version: "1.0.1" })),
    }),
    resolveCapabilities: async (subject) => await resolveProviderMaintenanceCapabilities(subject, {
      home: scenario.home,
      environment: async () => environment,
      ...(scenario.packageSpec ? { packageSpec: () => scenario.packageSpec! } : {}),
    }),
    installationIdentity: (subject) => providerInstallationIdentity({
      providerId: subject.providerId,
      executable: subject.executable,
      installationRootIdentity: null,
      packageIdentity: null,
      version: subject.installedVersion,
      ...(scenario.replacementBoundary
        ? { replacementBoundaryIdentity: scenario.replacementBoundary }
        : {}),
    }),
    runAction: async (action, options) => await runProviderMaintenanceAction(action, {
      environment: environment.env,
      cwd: scenario.home,
      signal: options.signal,
      onProgress: options.onProgress,
    }),
    onOperation: (operation) => operations.push(operation),
  });
  const [status] = await controller.refresh([scenario.providerId]);
  const started = await controller.startUpdate(scenario.providerId);
  const terminal = await new Promise<ProviderMaintenanceOperation>((resolve) => {
    const inspect = (): void => {
      const done = operations.find((operation) => operation.id === started.id
        && ["succeeded", "unchanged", "failed", "cancelled"].includes(operation.status));
      if (done) resolve(done);
      else setTimeout(inspect, 10);
    };
    inspect();
  });
  return { status, terminal, controller };
}

describe("provider maintenance on real installation layouts", () => {
  it.skipIf(process.platform === "win32" || !existsSync(npmCli))(
    "updates a stub package installed by npm into a temporary prefix",
    { timeout: 120_000 },
    async () => {
      const { root, home } = await layout();
      const tarballs = join(root, "tarballs");
      await mkdir(tarballs);
      for (const version of ["1.0.0", "1.0.1"]) {
        const source = join(root, `source-${version}`);
        await file(join(source, "package.json"), JSON.stringify({
          name: "@openai/codex",
          version,
          bin: { codex: "bin/codex.js" },
        }));
        await file(join(source, "bin/codex.js"), `#!/usr/bin/env node\nconsole.log("codex-cli ${version}");\n`);
        execFileSync(process.execPath, [npmCli, "pack", source, "--pack-destination", tarballs], {
          env: { PATH: `${nodeBin}:/usr/bin:/bin`, HOME: home },
          stdio: "ignore",
        });
      }
      const prefix = join(home, ".npm-global");
      execFileSync(process.execPath, [
        npmCli, "install", "-g", "--prefix", prefix, "--offline", "--no-audit", "--no-fund",
        join(tarballs, "openai-codex-1.0.0.tgz"),
      ], { env: { PATH: `${nodeBin}:/usr/bin:/bin`, HOME: home }, stdio: "ignore" });
      const manifest = join(prefix, "lib/node_modules/@openai/codex/package.json");

      const { status, terminal, controller } = await runUpdate({
        providerId: "codex",
        home,
        pathEntries: [join(prefix, "bin")],
        executable: async () => await realpath(join(prefix, "bin/codex")),
        version: async () => await versionOf(manifest),
        packageSpec: join(tarballs, "openai-codex-1.0.1.tgz"),
      });

      expect(status).toMatchObject({
        installMethod: "npm-global",
        updateAvailability: "available",
        versionStatus: "update-available",
      });
      expect(terminal).toMatchObject({ status: "succeeded", beforeVersion: "1.0.0", afterVersion: "1.0.1" });
      expect(await versionOf(manifest)).toBe("1.0.1");
      expect(controller.hasBlockingAuthority("codex")).toBe(false);
    },
  );

  posixIt("updates a pnpm global install through the pnpm in PNPM_HOME", async () => {
    const { home, record } = await layout();
    const pnpmHome = join(home, ".local/share/pnpm");
    const manifest = join(pnpmHome, "global/5/node_modules/@anthropic-ai/claude-code/package.json");
    await packageJson(manifest, "@anthropic-ai/claude-code", "1.0.0");
    await fakeManager(join(pnpmHome, "pnpm"), record, bump(manifest));
    const shim = await file(join(pnpmHome, "claude"), "#!/bin/sh\nexec node \"$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js\" \"$@\"\n");
    const { terminal } = await runUpdate({
      providerId: "claude",
      home,
      pathEntries: [pnpmHome],
      env: { PNPM_HOME: pnpmHome },
      executable: async () => shim,
      version: async () => await versionOf(manifest),
    });
    expect(terminal).toMatchObject({ status: "succeeded", afterVersion: "1.0.1" });
    expect(await records(record)).toEqual([{
      argv: ["add", "-g", "--allow-build=@anthropic-ai/claude-code", "@anthropic-ai/claude-code@latest"],
      env: { CI: "1", PNPM_HOME: pnpmHome },
    }]);
  });

  posixIt("updates a bun global install with its own bun", async () => {
    const { home, record } = await layout();
    const bunHome = join(home, ".bun");
    const packageRoot = join(bunHome, "install/global/node_modules/@moonshot-ai/kimi-code");
    await packageJson(join(packageRoot, "package.json"), "@moonshot-ai/kimi-code", "1.0.0");
    const entry = await file(join(packageRoot, "bin/kimi.js"), "#!/bin/sh\n");
    await link(entry, join(bunHome, "bin/kimi"));
    await fakeManager(join(bunHome, "bin/bun"), record, bump(join(packageRoot, "package.json")));
    const { terminal } = await runUpdate({
      providerId: "kimi",
      home,
      pathEntries: [join(bunHome, "bin")],
      executable: async () => entry,
      version: async () => await versionOf(join(packageRoot, "package.json")),
    });
    expect(terminal).toMatchObject({ status: "succeeded", afterVersion: "1.0.1" });
    expect(await records(record)).toEqual([{
      argv: ["add", "-g", "@moonshot-ai/kimi-code@latest"],
      env: { BUN_INSTALL: bunHome, CI: "1" },
    }]);
  });

  posixIt("updates a Volta package and keeps OpenCode on 1.x", async () => {
    const { home, record } = await layout();
    const voltaHome = join(home, ".volta");
    const manifest = join(voltaHome, "tools/image/packages/opencode-ai/package.json");
    await packageJson(manifest, "opencode-ai", "1.0.0");
    const shim = await file(join(voltaHome, "bin/volta-shim"), "#!/bin/sh\n");
    const command = await link(shim, join(voltaHome, "bin/opencode"));
    await fakeManager(join(voltaHome, "bin/volta"), record, bump(manifest));
    const { terminal } = await runUpdate({
      providerId: "opencode",
      home,
      pathEntries: [join(voltaHome, "bin")],
      executable: async () => command,
      version: async () => await versionOf(manifest),
    });
    expect(terminal).toMatchObject({ status: "succeeded", afterVersion: "1.0.1" });
    expect(await records(record)).toEqual([{
      argv: ["install", "opencode-ai@1"],
      env: { CI: "1", VOLTA_HOME: voltaHome },
    }]);
  });

  posixIt("updates a yarn classic global install with yarn from PATH", async () => {
    const { root, home, record } = await layout();
    const packageRoot = join(home, ".config/yarn/global/node_modules/@openai/codex");
    await packageJson(join(packageRoot, "package.json"), "@openai/codex", "1.0.0");
    const entry = await file(join(packageRoot, "bin/codex.js"), "#!/bin/sh\n");
    await link(entry, join(home, ".yarn/bin/codex"));
    await fakeManager(join(root, "tools/yarn"), record, bump(join(packageRoot, "package.json")));
    const { terminal } = await runUpdate({
      providerId: "codex",
      home,
      pathEntries: [join(home, ".yarn/bin"), join(root, "tools")],
      executable: async () => entry,
      version: async () => await versionOf(join(packageRoot, "package.json")),
    });
    expect(terminal).toMatchObject({ status: "succeeded", afterVersion: "1.0.1" });
    expect(await records(record)).toEqual([{ argv: ["global", "add", "@openai/codex@latest"], env: { CI: "1" } }]);
  });

  posixIt("upgrades a Homebrew cask with the brew that owns the keg", async () => {
    const { root, home, record } = await layout();
    const prefix = join(root, "linuxbrew");
    const manifest = join(prefix, "Caskroom/claude-code/1.0.0/package.json");
    await packageJson(manifest, "claude-code", "1.0.0");
    const executable = await file(join(prefix, "Caskroom/claude-code/1.0.0/claude"), "#!/bin/sh\n");
    await link(executable, join(prefix, "bin/claude"));
    const brew = await fakeManager(join(prefix, "Homebrew/bin/brew"), record, [
      "if (process.argv[2] === \"info\") {",
      "  process.stdout.write(JSON.stringify({ formulae: [], casks: [{ version: \"1.0.1,42\" }] }));",
      "  process.exit(0);",
      "}",
      bump(manifest),
    ].join("\n"));
    await link(brew, join(prefix, "bin/brew"));
    const { status, terminal } = await runUpdate({
      providerId: "claude",
      home,
      pathEntries: [join(prefix, "bin")],
      executable: async () => executable,
      version: async () => await versionOf(manifest),
    });
    expect(status).toMatchObject({ latestVersion: "1.0.1", versionStatus: "update-available" });
    expect(terminal).toMatchObject({ status: "succeeded", afterVersion: "1.0.1" });
    const info = { argv: ["info", "--json=v2", "--cask", "claude-code"], env: { CI: "1", HOMEBREW_NO_AUTO_UPDATE: "1" } };
    expect(await records(record)).toEqual([
      info,
      { argv: ["upgrade", "--cask", "claude-code"], env: { CI: "1" } },
      info,
    ]);
  });

  posixIt.each([
    ["needs no input", "process.stdin.resume(); process.stdin.on(\"end\", () => process.exit(0));", "succeeded"],
    ["would prompt", "process.stdin.resume(); process.stdin.on(\"end\", () => { console.error(\"no answer\"); process.exit(1); });", "failed"],
  ] as const)("runs agy update with closed input when the updater %s", async (_case, behaviour, status) => {
    const { home, record } = await layout();
    const manifest = join(home, ".local/share/agy-version.json");
    await packageJson(manifest, "agy", "1.0.0");
    const agy = await fakeManager(
      join(home, ".local/bin/agy"),
      record,
      `${status === "succeeded" ? bump(manifest) : ""}\n${behaviour}`,
    );
    const { terminal, controller } = await runUpdate({
      providerId: "antigravity",
      home,
      pathEntries: [join(home, ".local/bin")],
      executable: async () => agy,
      version: async () => await versionOf(manifest),
    });
    expect(terminal.status).toBe(status);
    expect(await records(record)).toEqual([{ argv: ["update"], env: { CI: "1" } }]);
    expect(controller.hasBlockingAuthority("antigravity")).toBe(false);
  });

  posixIt.each([
    ["within its command boundary", "cursor-agent", "succeeded", false],
    ["without a stable boundary", undefined, "failed", true],
  ] as const)("verifies a cursor-agent self-update that moves to a new version directory %s", async (_case, boundary, status, quarantined) => {
    const { home, record } = await layout();
    const versions = join(home, ".local/share/cursor-agent/versions");
    const first = join(versions, "2026.10.01-aaaaaaa");
    const second = join(versions, "2026.10.08-bbbbbbb");
    const linkPath = join(home, ".local/bin/cursor-agent");
    await packageJson(join(first, "package.json"), "cursor-agent", "1.0.0");
    await packageJson(join(second, "package.json"), "cursor-agent", "1.0.1");
    await file(join(second, "cursor-agent"), "#!/bin/sh\n");
    const installed = await fakeManager(join(first, "cursor-agent"), record, [
      `fs.unlinkSync(${JSON.stringify(linkPath)});`,
      `fs.symlinkSync(${JSON.stringify(join(second, "cursor-agent"))}, ${JSON.stringify(linkPath)});`,
    ].join("\n"));
    await link(installed, linkPath);
    const { terminal, controller } = await runUpdate({
      providerId: "cursor",
      home,
      pathEntries: [join(home, ".local/bin")],
      executable: async () => await realpath(linkPath),
      version: async () => await versionOf(join(dirname(await realpath(linkPath)), "package.json")),
      ...(boundary ? { replacementBoundary: boundary } : {}),
    });
    expect(terminal.status).toBe(status);
    expect(await records(record)).toEqual([{ argv: ["update"], env: { CI: "1" } }]);
    expect(controller.hasBlockingAuthority("cursor")).toBe(quarantined);
    await unlink(linkPath);
  });
});
