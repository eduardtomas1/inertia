import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  ProcessTreeCleanupError,
  runBounded,
} from "./bounded-process-tree.mjs";
import {
  acquireGuardianBuildLock,
  beginGuardianBuildChildLaunch,
  clearGuardianBuildChild,
  cleanGuardianBuildState,
  cleanGuardianLockArtifacts,
  cleanLegacyGuardianStages,
  recoverGuardianPublication,
  recordGuardianBuildChild,
  quarantineGuardianBuildChild,
  releaseGuardianBuildLock,
  startGuardianBuildLockHeartbeat,
  validateGuardianArtifactSet,
} from "./runtime-process-guardian-publication.mjs";

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
const generatedDirectory = resolve(outputDirectory, "..");
const stateDirectory = join(
  generatedDirectory,
  ".runtime-process-guardian-build",
);
const targets = {
  guardian: join(outputDirectory, "runtime-process-guardian"),
  integrity: join(generatedDirectory, "windows-runtime-job-integrity.json"),
  windowsJob: join(outputDirectory, "windows-runtime-job.exe"),
};
const testPlatform =
  process.env.NODE_ENV === "test" &&
  ["darwin", "linux", "win32"].includes(
    process.env.INERTIA_TEST_GUARDIAN_PLATFORM ?? "",
  )
    ? process.env.INERTIA_TEST_GUARDIAN_PLATFORM
    : null;
const platform = testPlatform ?? process.platform;
const testBundledIntegrity =
  process.env.NODE_ENV === "test" &&
  typeof process.env.INERTIA_TEST_GUARDIAN_BUNDLED_INTEGRITY === "string" &&
  isAbsolute(process.env.INERTIA_TEST_GUARDIAN_BUNDLED_INTEGRITY)
    ? resolve(process.env.INERTIA_TEST_GUARDIAN_BUNDLED_INTEGRITY)
    : null;
const bundledIntegrityPath =
  testBundledIntegrity ??
  join(root, "out", "main", "windows-runtime-job-bundled-integrity.json");
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
const postBuilderDelayMs =
  process.env.NODE_ENV === "test"
    ? Math.max(
        0,
        Number.parseInt(
          process.env.INERTIA_TEST_POST_BUILDER_DELAY_MS ?? "0",
          10,
        ) || 0,
      )
    : 0;
const postBuilderMarker =
  process.env.NODE_ENV === "test" &&
  typeof process.env.INERTIA_TEST_POST_BUILDER_MARKER === "string" &&
  isAbsolute(process.env.INERTIA_TEST_POST_BUILDER_MARKER)
    ? process.env.INERTIA_TEST_POST_BUILDER_MARKER
    : null;
const finalCleanupDelayMs =
  process.env.NODE_ENV === "test"
    ? Math.max(
        0,
        Number.parseInt(
          process.env.INERTIA_TEST_FINAL_CLEANUP_DELAY_MS ?? "0",
          10,
        ) || 0,
      )
    : 0;
const finalCleanupMarker =
  process.env.NODE_ENV === "test" &&
  typeof process.env.INERTIA_TEST_FINAL_CLEANUP_MARKER === "string" &&
  isAbsolute(process.env.INERTIA_TEST_FINAL_CLEANUP_MARKER)
    ? process.env.INERTIA_TEST_FINAL_CLEANUP_MARKER
    : null;

function builderInvocation() {
  const testBuilder =
    process.env.NODE_ENV === "test" &&
    typeof process.env.INERTIA_TEST_ELECTRON_BUILDER_SCRIPT === "string" &&
    isAbsolute(process.env.INERTIA_TEST_ELECTRON_BUILDER_SCRIPT)
      ? process.env.INERTIA_TEST_ELECTRON_BUILDER_SCRIPT
      : null;
  return testBuilder
    ? { command: process.execPath, prefix: [testBuilder] }
    : {
        command: process.execPath,
        prefix: [join(root, "node_modules", "electron-builder", "cli.js")],
      };
}

function validateRequestedPackagePlatform(arguments_) {
  const requested = new Set();
  const flags = new Map([
    ["--linux", "linux"],
    ["-l", "linux"],
    ["--mac", "darwin"],
    ["--macos", "darwin"],
    ["-m", "darwin"],
    ["--win", "win32"],
    ["--windows", "win32"],
    ["-w", "win32"],
  ]);
  for (const argument of arguments_) {
    const requestedPlatform = flags.get(argument.split("=", 1)[0]);
    if (requestedPlatform) requested.add(requestedPlatform);
  }
  if (requested.size > 1) {
    throw new Error(
      "Conflicting electron-builder target platforms were requested.",
    );
  }
  const [requestedPlatform] = requested;
  if (requestedPlatform && requestedPlatform !== platform) {
    throw new Error(
      `Refusing to package ${requestedPlatform} artifacts with a ${platform} runtime guardian.`,
    );
  }
  const requestedArchitectures = new Set();
  const architectureFlags = new Map([
    ["--arm64", "arm64"],
    ["--armv7l", "arm"],
    ["--ia32", "ia32"],
    ["--x64", "x64"],
  ]);
  for (const argument of arguments_) {
    const requestedArchitecture = architectureFlags.get(
      argument.split("=", 1)[0],
    );
    if (requestedArchitecture)
      requestedArchitectures.add(requestedArchitecture);
    if (argument.split("=", 1)[0] === "--universal") {
      requestedArchitectures.add("universal");
    }
  }
  if (requestedArchitectures.size > 1) {
    throw new Error(
      "Conflicting electron-builder target architectures were requested.",
    );
  }
  const [requestedArchitecture] = requestedArchitectures;
  if (requestedArchitecture && requestedArchitecture !== process.arch) {
    throw new Error(
      `Refusing to package ${requestedArchitecture} artifacts with a ${process.arch} runtime guardian.`,
    );
  }
}

function readIntegrity(path, label) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > 4_096
  )
    throw new Error(`${label} is missing or invalid.`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    !("sha256" in value) ||
    (value.sha256 !== null &&
      (typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.sha256)))
  )
    throw new Error(`${label} is invalid.`);
  return value.sha256;
}

function validateBundledGuardianIntegrity() {
  const generated = readIntegrity(
    targets.integrity,
    "The generated Windows runtime Job Object integrity manifest",
  );
  const bundled = readIntegrity(
    bundledIntegrityPath,
    "The bundled Windows runtime Job Object integrity snapshot",
  );
  if (generated !== bundled) {
    throw new Error(
      "The bundled Windows runtime Job Object integrity snapshot is stale; rebuild before packaging.",
    );
  }
  if ((platform === "win32") !== (typeof bundled === "string")) {
    throw new Error(
      "The bundled Windows runtime Job Object integrity snapshot targets a different platform.",
    );
  }
}

function validatePlatformGuardianProtocol() {
  if (platform !== "linux") return;
  const before = statSync(targets.guardian, { bigint: true });
  const result = spawnSync(targets.guardian, ["seccomp-selftest-identity"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    killSignal: "SIGKILL",
    maxBuffer: 4_096,
    shell: false,
    timeout: 15_000,
  });
  const after = statSync(targets.guardian, { bigint: true });
  const match =
    typeof result.stdout === "string"
      ? result.stdout
          .trim()
          .match(
            /^[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|([1-9][0-9]*)\|([1-9][0-9]*)$/u,
          )
      : null;
  if (
    result.error ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    !match ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    match[1] !== String(before.dev) ||
    match[2] !== String(before.ino)
  )
    throw new Error("The Linux runtime guardian identity self-test failed.");
}

async function main() {
  const builderArguments = process.argv.slice(2);
  validateRequestedPackagePlatform(builderArguments);
  const lock = acquireGuardianBuildLock(stateDirectory);
  const abortController = new AbortController();
  let stopHeartbeat = () => {};
  let childAuthorityActive = false;
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let receivedSignal = null;
  let heartbeatCompromise = null;
  let cleanupUnconfirmed = false;
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        receivedSignal ??= signal;
        abortController.abort();
      },
    ]),
  );
  try {
    cleanGuardianLockArtifacts(stateDirectory, lock);
    recoverGuardianPublication(stateDirectory, targets);
    cleanGuardianBuildState(stateDirectory);
    cleanLegacyGuardianStages(targets);
    validateGuardianArtifactSet(platform, targets);
    validateBundledGuardianIntegrity();
    validatePlatformGuardianProtocol();
    stopHeartbeat = startGuardianBuildLockHeartbeat(lock, {
      intervalMs: heartbeatIntervalMs,
      onCompromised: (error) => {
        heartbeatCompromise ??= error;
        abortController.abort();
      },
    });
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const invocation = builderInvocation();
    beginGuardianBuildChildLaunch(lock);
    childAuthorityActive = true;
    await runBounded(
      invocation.command,
      [...invocation.prefix, ...builderArguments],
      {
        cwd: root,
        echoOutputLive: true,
        env: process.env,
        label: "electron-builder",
        onSpawn: (child) => recordGuardianBuildChild(lock, child),
        signal: abortController.signal,
        timeoutMs: 4 * 60 * 60_000,
        windowsJobGuardian: {
          integrityPath: targets.integrity,
          path: targets.windowsJob,
        },
      },
    );
    if (
      process.env.NODE_ENV === "test" &&
      process.env.INERTIA_TEST_PROCESS_TREE_CLEANUP_UNCONFIRMED === "1"
    ) {
      throw new ProcessTreeCleanupError(
        "Injected unconfirmed electron-builder process-tree cleanup.",
      );
    }
    if (postBuilderMarker) writeFileSync(postBuilderMarker, "settled", "utf8");
    if (postBuilderDelayMs > 0) {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, postBuilderDelayMs);
      });
    }
    clearGuardianBuildChild(lock);
    childAuthorityActive = false;
    if (receivedSignal !== null || heartbeatCompromise !== null) {
      throw new Error(
        receivedSignal !== null
          ? `electron-builder was interrupted by ${String(receivedSignal)}.`
          : "The runtime guardian build lock was compromised.",
      );
    }
    validateGuardianArtifactSet(platform, targets);
    validateBundledGuardianIntegrity();
    if (receivedSignal !== null || heartbeatCompromise !== null) {
      throw new Error(
        receivedSignal !== null
          ? `electron-builder was interrupted by ${String(receivedSignal)}.`
          : "The runtime guardian build lock was compromised.",
      );
    }
  } catch (error) {
    cleanupUnconfirmed = error instanceof ProcessTreeCleanupError;
    if (cleanupUnconfirmed && childAuthorityActive) {
      quarantineGuardianBuildChild(lock);
    }
    throw error;
  } finally {
    if (!cleanupUnconfirmed && childAuthorityActive)
      clearGuardianBuildChild(lock);
    if (finalCleanupMarker)
      writeFileSync(finalCleanupMarker, "cleanup", "utf8");
    if (finalCleanupDelayMs > 0) {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, finalCleanupDelayMs);
      });
    }
    stopHeartbeat();
    if (!cleanupUnconfirmed) releaseGuardianBuildLock(lock);
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
  }
  if (receivedSignal !== null || heartbeatCompromise !== null) {
    throw new Error(
      receivedSignal !== null
        ? `electron-builder was interrupted by ${String(receivedSignal)}.`
        : "The runtime guardian build lock was compromised.",
    );
  }
}

await main();
