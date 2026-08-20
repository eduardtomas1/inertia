import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_OUTPUT_CHARS = 64 * 1024;
const INSTALL_TIMEOUT_MS = 8 * 60 * 1_000;
const TYPECHECK_TIMEOUT_MS = 2 * 60 * 1_000;
const CLI_TIMEOUT_MS = 20_000;

const productSdks = [
  "@agentclientprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/sdk",
];
const latestPackages = [
  "@openai/codex",
  "@anthropic-ai/claude-code",
  "@moonshot-ai/kimi-code",
  "opencode-ai",
];

function parseArguments(argv) {
  const values = { cursorAgent: "", report: "", workspace: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--cursor-agent", "--report", "--workspace"].includes(name) || !value) {
      throw new Error(`Unknown or incomplete argument: ${name ?? ""}`);
    }
    if (name === "--cursor-agent") values.cursorAgent = resolve(value);
    if (name === "--report") values.report = resolve(value);
    if (name === "--workspace") values.workspace = resolve(value);
    index += 1;
  }
  if (!values.report || !values.workspace) {
    throw new Error("--workspace and --report are required.");
  }
  return values;
}

function sanitizedEnvironment(isolatedRoot) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|AUTH)/iu.test(name)) continue;
    if (/^(?:ACTIONS_|GITHUB_)/u.test(name)) continue;
    environment[name] = value;
  }
  return {
    ...environment,
    CI: "true",
    NO_COLOR: "1",
    XDG_CACHE_HOME: join(isolatedRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(isolatedRoot, "xdg-config"),
    XDG_DATA_HOME: join(isolatedRoot, "xdg-data"),
    CLAUDE_CONFIG_DIR: join(isolatedRoot, "claude-config"),
    NPM_CONFIG_USERCONFIG: join(isolatedRoot, "npmrc"),
  };
}

function terminate(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the checks.
    }
  }
}

function commandResult(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  return new Promise((settle, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let outputTruncated = false;
    const capture = (chunk) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        outputTruncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const remaining = MAX_OUTPUT_CHARS - output.length;
      output += text.slice(0, remaining);
      if (text.length > remaining) outputTruncated = true;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      terminate(child);
      reject(new Error(`${basename(command)} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      settle({ code, signal, output, outputTruncated });
    });
  });
}

async function requireSuccessfulCommand(command, args, options = {}) {
  const result = await commandResult(command, args, options);
  if (result.code !== 0) {
    const suffix = result.outputTruncated ? "\n[output capped]" : "";
    console.error(`${result.output}${suffix}`);
    throw new Error(
      `${basename(command)} exited with ${result.code ?? result.signal ?? "unknown status"}.`,
    );
  }
  if (!options.allowEmpty && !result.output.trim()) {
    throw new Error(`${basename(command)} returned no help or version output.`);
  }
  return result.output;
}

async function packageVersion(root, name) {
  const packageJson = JSON.parse(
    await readFile(join(root, "node_modules", ...name.split("/"), "package.json"), "utf8"),
  );
  if (typeof packageJson.version !== "string") {
    throw new Error(`${name} did not expose a package version.`);
  }
  return packageJson.version;
}

function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const isolatedConfig = join(options.workspace, "isolated-config");
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    productPackages: {},
    latestPackages: {},
    checks: [],
  };
  let failed = false;

  const check = async (name, operation) => {
    process.stdout.write(`::group::${name}\n`);
    try {
      await operation();
      report.checks.push({ name, status: "passed" });
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed = true;
      report.checks.push({ name, status: "failed" });
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      process.stdout.write("::endgroup::\n");
    }
  };

  await mkdir(options.workspace, { recursive: true });
  await mkdir(isolatedConfig, { recursive: true });
  await writeFile(join(isolatedConfig, "npmrc"), "", "utf8");
  const environment = sanitizedEnvironment(isolatedConfig);

  await check("product SDK manifests are exact and match the locked install", async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    for (const name of productSdks) {
      const requested = packageJson.dependencies?.[name];
      const installed = await packageVersion(repositoryRoot, name);
      report.productPackages[name] = installed;
      if (!isExactVersion(requested)) {
        throw new Error(`${name} must use an exact version in package.json.`);
      }
      if (requested !== installed) {
        throw new Error(`${name} manifest and installed versions differ.`);
      }
    }
  });

  await writeFile(
    join(options.workspace, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );

  let latestInstalled = false;
  await check("install latest provider SDKs and official npm CLIs in isolation", async () => {
    await requireSuccessfulCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        ...productSdks.map((name) => `${name}@latest`),
      ],
      { cwd: options.workspace, environment, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    await requireSuccessfulCommand(
      "npm",
      [
        "install",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        ...latestPackages.map((name) => `${name}@latest`),
      ],
      { cwd: options.workspace, environment, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    for (const name of [...productSdks, ...latestPackages]) {
      report.latestPackages[name] = await packageVersion(options.workspace, name);
    }
    latestInstalled = true;
  });

  if (latestInstalled) {
    await check("compile product-used SDK type surfaces against latest", async () => {
      const source = join(repositoryRoot, "scripts", "provider-drift-sdk-surface.ts");
      const target = join(options.workspace, "provider-drift-sdk-surface.ts");
      await copyFile(source, target);
      await requireSuccessfulCommand(
        process.execPath,
        [
          join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          target,
        ],
        {
          cwd: options.workspace,
          environment,
          timeoutMs: TYPECHECK_TIMEOUT_MS,
          allowEmpty: true,
        },
      );
    });

    await check("construct product-used SDK runtime surfaces against latest", async () => {
      const source = join(repositoryRoot, "scripts", "provider-drift-sdk-runtime.mjs");
      const target = join(options.workspace, "provider-drift-sdk-runtime.mjs");
      await copyFile(source, target);
      await requireSuccessfulCommand(
        process.execPath,
        [target],
        { cwd: options.workspace, environment },
      );
    });

    const bin = (name) => join(options.workspace, "node_modules", ".bin", name);
    await check("Codex latest CLI exposes version and app-server help", async () => {
      const version = await requireSuccessfulCommand(
        bin("codex"),
        ["--version"],
        { cwd: options.workspace, environment },
      );
      const help = await requireSuccessfulCommand(
        bin("codex"),
        ["app-server", "--help"],
        { cwd: options.workspace, environment },
      );
      if (!/codex/iu.test(version) || !/(?:app-server|app server)/iu.test(help)) {
        throw new Error("Codex CLI output no longer identifies the app-server surface.");
      }
    });

    await check("Codex generated notification discriminants are exhaustively reviewed", async () => {
      const generatedRoot = join(options.workspace, "codex-app-server-types");
      await mkdir(generatedRoot, { recursive: true });
      await requireSuccessfulCommand(
        bin("codex"),
        ["app-server", "generate-ts", "--experimental", "--out", generatedRoot],
        {
          cwd: options.workspace,
          environment,
          timeoutMs: TYPECHECK_TIMEOUT_MS,
          allowEmpty: true,
        },
      );
      const generated = await readFile(
        join(generatedRoot, "ServerNotification.ts"),
        "utf8",
      );
      const generatedMethods = [...generated.matchAll(
        /"method"\s*:\s*"([^"]+)"/gu,
      )].map((match) => match[1]).sort();
      const dispositions = await readFile(
        join(
          repositoryRoot,
          "src",
          "server",
          "codex",
          "app-server-notifications.ts",
        ),
        "utf8",
      );
      const table = dispositions.match(
        /CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS\s*=\s*\{([\s\S]*?)\}\s*as const/u,
      )?.[1] ?? "";
      const reviewedMethods = [...table.matchAll(
        /^\s*(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*))\s*:/gmu,
      )].map((match) => match[1] ?? match[2]).sort();
      if (generatedMethods.length === 0) {
        throw new Error("Codex generated no ServerNotification discriminants.");
      }
      if (JSON.stringify(generatedMethods) !== JSON.stringify(reviewedMethods)) {
        const generatedSet = new Set(generatedMethods);
        const reviewedSet = new Set(reviewedMethods);
        const added = generatedMethods.filter((method) => !reviewedSet.has(method));
        const removed = reviewedMethods.filter((method) => !generatedSet.has(method));
        throw new Error(
          `Codex notification surface drifted. Added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}.`,
        );
      }
    });

    await check("Claude latest CLI exposes version and authentication help", async () => {
      const version = await requireSuccessfulCommand(
        bin("claude"),
        ["--version"],
        { cwd: options.workspace, environment },
      );
      const help = await requireSuccessfulCommand(
        bin("claude"),
        ["auth", "--help"],
        { cwd: options.workspace, environment },
      );
      if (!/claude/iu.test(version) || !/(?:status|login|logout)/iu.test(help)) {
        throw new Error("Claude CLI output no longer identifies its authentication surface.");
      }
    });

    await check("Kimi latest CLI exposes version and ACP help", async () => {
      const version = await requireSuccessfulCommand(
        bin("kimi"),
        ["--version"],
        { cwd: options.workspace, environment },
      );
      const help = await requireSuccessfulCommand(
        bin("kimi"),
        ["acp", "--help"],
        { cwd: options.workspace, environment },
      );
      if (!version.trim() || !/(?:acp|agent client protocol)/iu.test(help)) {
        throw new Error("Kimi CLI output no longer identifies its ACP surface.");
      }
    });

    await check("OpenCode latest CLI exposes version and server help", async () => {
      const version = await requireSuccessfulCommand(
        bin("opencode"),
        ["--version"],
        { cwd: options.workspace, environment },
      );
      const help = await requireSuccessfulCommand(
        bin("opencode"),
        ["serve", "--help"],
        { cwd: options.workspace, environment },
      );
      if (!/\d+\.\d+/u.test(version) || !/(?:port|hostname|serve)/iu.test(help)) {
        throw new Error("OpenCode CLI output no longer identifies its server surface.");
      }
    });
  }

  if (options.cursorAgent) {
    await check("Cursor latest CLI exposes version and ACP help", async () => {
      const version = await requireSuccessfulCommand(
        options.cursorAgent,
        ["--version"],
        { cwd: options.workspace, environment },
      );
      const help = await requireSuccessfulCommand(
        options.cursorAgent,
        ["acp", "--help"],
        { cwd: options.workspace, environment },
      );
      if (!version.trim() || !/(?:acp|agent client protocol)/iu.test(help)) {
        throw new Error("Cursor CLI output no longer identifies its ACP surface.");
      }
    });
  }

  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const packageRows = Object.entries(report.latestPackages)
      .map(([name, version]) => `| ${name} | ${version} |`)
      .join("\n");
    const checkRows = report.checks
      .map(({ name, status }) => `| ${name} | ${status} |`)
      .join("\n");
    const summary = [
      "## Provider drift canary",
      "",
      "| Latest package | Resolved version |",
      "| --- | --- |",
      packageRows || "| Installation unavailable | — |",
      "",
      "| Check | Result |",
      "| --- | --- |",
      checkRows,
      "",
    ].join("\n");
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { encoding: "utf8", flag: "a" });
  }
  if (failed) process.exitCode = 1;
}

await main();
