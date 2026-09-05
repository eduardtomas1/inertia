import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

import {
  acquireGuardianBuildLock,
  beginGuardianBuildChildLaunch,
  clearGuardianBuildChild,
  cleanGuardianLockArtifacts,
  cleanGuardianBuildState,
  cleanLegacyGuardianStages,
  publishGuardianArtifacts,
  recoverGuardianPublication,
  recordGuardianBuildChild,
  quarantineGuardianBuildChild,
  renewGuardianBuildLock,
  releaseGuardianBuildLock,
  startGuardianBuildLockHeartbeat,
} from "./runtime-process-guardian-publication.mjs";
import {
  ProcessTreeCleanupError,
  runBounded,
} from "./bounded-process-tree.mjs";

const root = resolve(import.meta.dirname, "..");
const testOutputDirectory =
  process.env.NODE_ENV === "test" &&
  typeof process.env.INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY === "string" &&
  isAbsolute(process.env.INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY)
    ? resolve(process.env.INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY)
    : null;
const outputDirectory =
  testOutputDirectory ??
  join(root, "resources", "generated", "runtime-process-guardian");
const targets = {
  guardian: join(outputDirectory, "runtime-process-guardian"),
  integrity: join(
    dirname(outputDirectory),
    "windows-runtime-job-integrity.json",
  ),
  windowsJob: join(outputDirectory, "windows-runtime-job.exe"),
};
const stateDirectory = join(
  dirname(outputDirectory),
  ".runtime-process-guardian-build",
);

function validateCompiledExecutable(path, label) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > 1024 * 1024
  )
    throw new Error(`${label} compiler did not produce a valid executable.`);
}

function compileStage(extension = "") {
  return join(
    stateDirectory,
    `compile-${process.pid}-${randomUUID()}${extension}`,
  );
}

function testPublicationFailure() {
  if (process.env.NODE_ENV !== "test") return undefined;
  const value = Number.parseInt(
    process.env.INERTIA_TEST_GUARDIAN_PUBLICATION_FAILURE_AFTER ?? "",
    10,
  );
  return value >= 1 && value <= 3 ? value : undefined;
}

async function buildWindowsGuardian(runCompiler, runBootstrapLeaf) {
  const environmentValue = (name) =>
    Object.entries(process.env)
      .find(
        ([key, value]) =>
          key.toLowerCase() === name.toLowerCase() && typeof value === "string",
      )?.[1]
      ?.trim();
  const systemRoot = environmentValue("SystemRoot");
  const temporary = environmentValue("TEMP") ?? environmentValue("TMP");
  if (
    !systemRoot ||
    !win32.isAbsolute(systemRoot) ||
    !/^[a-z]:\\/iu.test(systemRoot) ||
    !temporary ||
    !win32.isAbsolute(temporary) ||
    !/^[a-z]:\\/iu.test(temporary)
  ) {
    throw new Error("The trusted Windows compiler environment is unavailable.");
  }
  const cscCandidates = ["Framework64", "Framework"].map((framework) =>
    win32.join(systemRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
  );
  const compiler = cscCandidates.find((candidate) => {
    const metadata = lstatSync(candidate, { throwIfNoEntry: false });
    return metadata?.isFile() && !metadata.isSymbolicLink();
  });
  if (!compiler)
    throw new Error("The trusted Windows C# compiler is unavailable.");
  const bootstrapOutput = compileStage(".bootstrap.exe");
  const stagedOutput = compileStage(".exe");
  const sourcePath = join(
    root,
    "native",
    "runtime-process-guardian",
    "windows.cs",
  );
  const compilerArguments = (output) => [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/main:InertiaRuntimeJob",
    `/out:${output}`,
    "/reference:System.dll",
    "/reference:System.Core.dll",
    sourcePath,
  ];
  const environment = {
    PATH: win32.dirname(compiler),
    SystemRoot: systemRoot,
    SYSTEMROOT: systemRoot,
    TEMP: win32.normalize(temporary),
    TMP: win32.normalize(temporary),
    WINDIR: systemRoot,
  };
  await runBootstrapLeaf(compiler, compilerArguments(bootstrapOutput), {
    cwd: root,
    env: environment,
    timeoutMs: 60_000,
  });
  validateCompiledExecutable(
    bootstrapOutput,
    "The bootstrap Windows runtime Job Object",
  );
  const bootstrapHash = createHash("sha256")
    .update(readFileSync(bootstrapOutput))
    .digest("hex");
  const bootstrapIntegrity = compileStage(".bootstrap.json");
  writeFileSync(
    bootstrapIntegrity,
    `${JSON.stringify({ sha256: bootstrapHash })}\n`,
    { mode: 0o600 },
  );
  let preserveBootstrapAuthority = false;
  try {
    await runCompiler(compiler, compilerArguments(stagedOutput), {
      cwd: root,
      env: environment,
      timeoutMs: 60_000,
      windowsJobGuardian: {
        integrityPath: bootstrapIntegrity,
        path: bootstrapOutput,
      },
    });
  } catch (error) {
    preserveBootstrapAuthority = error instanceof ProcessTreeCleanupError;
    throw error;
  } finally {
    if (!preserveBootstrapAuthority) {
      rmSync(bootstrapIntegrity, { force: true });
      rmSync(bootstrapOutput, { force: true });
    }
  }
  validateCompiledExecutable(stagedOutput, "The Windows runtime Job Object");
  const sha256 = createHash("sha256")
    .update(readFileSync(stagedOutput))
    .digest("hex");
  // The publication transaction writes JSON.stringify({ sha256 }) beside the
  // exact staged executable whose digest was computed here.
  return { sha256, stagedOutput };
}

async function buildUnixGuardian(runCompiler) {
  const linuxGnuTriplet =
    process.arch === "x64"
      ? "x86_64-linux-gnu"
      : process.arch === "arm64"
        ? "aarch64-linux-gnu"
        : null;
  if (process.platform === "linux" && !linuxGnuTriplet) {
    throw new Error(
      `The Linux runtime process guardian does not support ${process.arch}.`,
    );
  }

  const configuredTestCompiler =
    process.env.NODE_ENV === "test" &&
    typeof process.env.INERTIA_TEST_GUARDIAN_COMPILER === "string" &&
    isAbsolute(process.env.INERTIA_TEST_GUARDIAN_COMPILER)
      ? process.env.INERTIA_TEST_GUARDIAN_COMPILER
      : null;
  const compiler =
    configuredTestCompiler ??
    (process.platform === "darwin" ? "/usr/bin/xcrun" : "/usr/bin/musl-gcc");
  const compilerArgs =
    process.platform === "darwin"
      ? ["clang"]
      : [
          "-static-pie",
          "-s",
          "-idirafter",
          "/usr/include",
          "-idirafter",
          `/usr/include/${linuxGnuTriplet}`,
        ];
  const stagedOutput = compileStage();
  try {
    await runCompiler(
      compiler,
      [
        ...compilerArgs,
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(
          root,
          "native",
          "runtime-process-guardian",
          `${process.platform}.c`,
        ),
        "-o",
        stagedOutput,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          ...(process.env.NODE_ENV === "test" &&
          process.env.INERTIA_TEST_GUARDIAN_COMPILER_TRACE
            ? {
                INERTIA_TEST_GUARDIAN_COMPILER_TRACE:
                  process.env.INERTIA_TEST_GUARDIAN_COMPILER_TRACE,
              }
            : {}),
        },
        maxBuffer: 64 * 1024,
        shell: false,
        timeoutMs:
          process.env.NODE_ENV === "test"
            ? Math.max(
                1,
                Number.parseInt(
                  process.env.INERTIA_TEST_GUARDIAN_COMPILER_TIMEOUT_MS ??
                    "30000",
                  10,
                ) || 30_000,
              )
            : 30_000,
      },
    );
  } catch (error) {
    if (
      process.platform === "linux" &&
      configuredTestCompiler === null &&
      error instanceof Error &&
      error.message.includes("ENOENT")
    ) {
      throw new Error(
        "The Linux runtime process guardian requires musl-tools, linux-libc-dev, and binutils.",
      );
    }
    throw error;
  }
  validateCompiledExecutable(
    stagedOutput,
    `The ${process.platform} runtime process guardian`,
  );
  return stagedOutput;
}

async function main() {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const lock = acquireGuardianBuildLock(stateDirectory);
  let childAuthorityActive = false;
  let cleanupUnconfirmed = false;
  let heartbeatCompromise = null;
  const abortController = new AbortController();
  const heartbeatIntervalMs =
    process.env.NODE_ENV === "test"
      ? Math.max(
          1,
          Number.parseInt(
            process.env.INERTIA_TEST_GUARDIAN_HEARTBEAT_INTERVAL_MS ?? "30000",
            10,
          ) || 30_000,
        )
      : 30_000;
  const stopHeartbeat = startGuardianBuildLockHeartbeat(lock, {
    intervalMs: heartbeatIntervalMs,
    onCompromised: (error) => {
      heartbeatCompromise ??= error;
      abortController.abort();
    },
  });
  const runBootstrapLeaf = async (command, args, options) => {
    beginGuardianBuildChildLaunch(lock);
    childAuthorityActive = true;
    const settlementToken = randomUUID();
    const payload = Buffer.from(
      JSON.stringify({
        args,
        command,
        holdAuthority: true,
        input: null,
        settlementToken,
      }),
      "utf8",
    ).toString("base64");
    // The trusted framework csc is a direct leaf. The admission trampoline
    // retains its exact ChildProcess handle and kills it when this wrapper's
    // authority pipe closes, covering timeout, signal, and wrapper death.
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "bounded-command-trampoline.mjs"), payload],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    const completion = new Promise((settle) => {
      child.once("error", (error) => settle({ error }));
      child.once("close", (code, signal) => settle({ code, signal }));
    });
    try {
      recordGuardianBuildChild(lock, { pid: child.pid, processGroupId: null });
    } catch (error) {
      child.kill("SIGKILL");
      await completion;
      clearGuardianBuildChild(lock);
      childAuthorityActive = false;
      throw error;
    }
    child.stdin.on("error", () => {
      // Trampoline completion reports failed admission or early exit.
    });
    child.stdin.write("GO\n");
    let timer;
    let removeAbortListener = () => {};
    const aborted = new Promise((settle) => {
      if (abortController.signal.aborted) {
        settle({ aborted: true });
        return;
      }
      const onAbort = () => settle({ aborted: true });
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        abortController.signal.removeEventListener("abort", onAbort);
    });
    const outcome = await Promise.race([
      completion,
      aborted,
      new Promise((settle) => {
        timer = setTimeout(() => settle({ timeout: true }), options.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    removeAbortListener();
    if (outcome.timeout || outcome.aborted) {
      child.stdin.end();
      const settled = await Promise.race([
        completion.then(() => true),
        new Promise((settle) => setTimeout(() => settle(false), 10_000)),
      ]);
      if (!settled) {
        child.kill("SIGKILL");
        const rootStopped = await Promise.race([
          completion.then(() => true),
          new Promise((settle) => setTimeout(() => settle(false), 10_000)),
        ]);
        if (rootStopped) {
          throw new ProcessTreeCleanupError(
            "The trusted Windows C# compiler descendant cleanup is unconfirmed.",
          );
        }
        throw new ProcessTreeCleanupError(
          "The trusted Windows C# compiler could not be confirmed stopped.",
        );
      }
      clearGuardianBuildChild(lock);
      childAuthorityActive = false;
      throw new Error(
        outcome.aborted
          ? "The runtime guardian build lock was compromised."
          : "The trusted Windows C# compiler timed out.",
      );
    }
    child.stdin.end();
    if (!output.includes(`INERTIA_SETTLED:${settlementToken}\n`)) {
      throw new ProcessTreeCleanupError(
        "The trusted Windows C# compiler settlement was not confirmed.",
      );
    }
    clearGuardianBuildChild(lock);
    childAuthorityActive = false;
    if (outcome.error || outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(output || "The trusted Windows C# compiler failed.");
    }
  };
  const runCompiler = async (command, args, options) => {
    beginGuardianBuildChildLaunch(lock);
    childAuthorityActive = true;
    try {
      await runBounded(command, args, {
        ...options,
        label: "runtime guardian compiler",
        onSpawn: (child) => recordGuardianBuildChild(lock, child),
        signal: abortController.signal,
        windowsJobGuardian: options.windowsJobGuardian ?? {
          integrityPath: targets.integrity,
          path: targets.windowsJob,
        },
      });
      clearGuardianBuildChild(lock);
      childAuthorityActive = false;
    } catch (error) {
      if (!(error instanceof ProcessTreeCleanupError)) {
        clearGuardianBuildChild(lock);
        childAuthorityActive = false;
      }
      throw error;
    }
  };
  try {
    cleanGuardianLockArtifacts(stateDirectory, lock);
    recoverGuardianPublication(stateDirectory, targets);
    cleanGuardianBuildState(stateDirectory);
    cleanLegacyGuardianStages(targets);
    let expectedWindowsHash;
    let stagedExecutable = null;
    if (process.platform === "win32") {
      const windowsBuild = await buildWindowsGuardian(
        runCompiler,
        runBootstrapLeaf,
      );
      expectedWindowsHash = windowsBuild.sha256;
      stagedExecutable = windowsBuild.stagedOutput;
    } else if (process.platform === "darwin" || process.platform === "linux") {
      stagedExecutable = await buildUnixGuardian(runCompiler);
    }
    if (heartbeatCompromise !== null) {
      throw new Error("The runtime guardian build lock was compromised.");
    }
    renewGuardianBuildLock(lock);
    publishGuardianArtifacts({
      expectedWindowsHash,
      failAfterOperation: testPublicationFailure(),
      platform: process.platform,
      stagedExecutable,
      stateDirectory,
      targets,
    });
  } catch (error) {
    cleanupUnconfirmed = error instanceof ProcessTreeCleanupError;
    if (cleanupUnconfirmed && childAuthorityActive) {
      quarantineGuardianBuildChild(lock);
    }
    throw error;
  } finally {
    stopHeartbeat();
    if (!cleanupUnconfirmed) {
      if (childAuthorityActive) clearGuardianBuildChild(lock);
      try {
        cleanGuardianBuildState(stateDirectory);
      } finally {
        releaseGuardianBuildLock(lock);
      }
    }
  }
}

await main();
