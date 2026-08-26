import { constants } from "node:fs";
import { access, lstat, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBounded } from "./bounded-process-tree.mjs";
import { inspectNativeBinaryArchitecture } from "./native-binary-architecture.mjs";

const ARCHITECTURES = new Set(["arm64", "x64"]);
const CHANNELS = new Set(["canary", "stable"]);
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const CONTAINER_TIMEOUT_MS = 3 * 60_000;
const PACKAGE_SMOKE_TIMEOUT_MS = 3 * 60_000;

function runContainerCommand(command, args, options = {}) {
  return runBounded(command, args, {
    ...options,
    label: options.label ?? command,
    timeoutMs: options.timeoutMs ?? CONTAINER_TIMEOUT_MS,
  });
}

function temporaryRootPreservationError(message, cause) {
  const error = new Error(message, { cause });
  error.name = "TemporaryRootPreservationError";
  error.preserveTemporaryRoot = true;
  return error;
}

export function macImageIsMounted(value, mountPoint) {
  if (!value || typeof value !== "object" || !Array.isArray(value.images)) return false;
  return value.images.some((image) => (
    image
    && typeof image === "object"
    && Array.isArray(image["system-entities"])
    && image["system-entities"].some((entity) => (
      entity
      && typeof entity === "object"
      && entity["mount-point"] === mountPoint
    ))
  ));
}

async function queryMacImageMount(mountPoint) {
  const plist = await runContainerCommand("hdiutil", ["info", "-plist"], {
    label: "macOS image mount-state query",
  });
  const json = await runContainerCommand(
    "plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    {
      input: plist,
      label: "macOS image mount-state decoding",
    },
  );
  let value;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new Error("The macOS image mount state is malformed.", { cause });
  }
  return macImageIsMounted(value, mountPoint);
}

export async function reconcileMacImageMount(mountPoint, operations = {}) {
  const queryMount = operations.queryMount ?? queryMacImageMount;
  const detach = operations.detach ?? (async () => {
    await runContainerCommand("hdiutil", ["detach", mountPoint, "-force"], {
      label: "macOS DMG detach",
    });
  });
  let mounted;
  try {
    mounted = await queryMount(mountPoint);
  } catch (cause) {
    throw temporaryRootPreservationError(
      `The macOS image state at ${mountPoint} could not be proven before cleanup.`,
      cause,
    );
  }
  if (!mounted) return;
  let detachError;
  try {
    await detach(mountPoint);
  } catch (error) {
    if (error?.preserveTemporaryRoot === true) throw error;
    detachError = error;
  }
  let stillMounted;
  try {
    stillMounted = await queryMount(mountPoint);
  } catch (cause) {
    throw temporaryRootPreservationError(
      `The macOS image state at ${mountPoint} could not be proven after detach.`,
      cause,
    );
  }
  if (stillMounted) {
    throw temporaryRootPreservationError(
      `The macOS image remains mounted at ${mountPoint}; preserving its smoke root.`,
      detachError,
    );
  }
  if (detachError) throw detachError;
}

async function requireRegularFile(path, executable = false) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    throw new Error(`Required release file is missing, empty, or indirect: ${path}.`);
  }
  if (executable && process.platform !== "win32") {
    await access(path, constants.X_OK).catch(() => {
      throw new Error(`Required release entry point is not executable: ${path}.`);
    });
  }
}

export function releaseContainerNames(version, channel, architecture) {
  if (!VERSION_PATTERN.test(version)) throw new Error("The release container version is invalid.");
  if (!CHANNELS.has(channel)) throw new Error("The release container channel is invalid.");
  if (!ARCHITECTURES.has(architecture)) throw new Error("The release container architecture is invalid.");
  const canary = channel === "canary";
  if (canary) {
    return {
      appImage: architecture === "arm64"
        ? `Inertia-Canary-${version}-arm64.AppImage`
        : `Inertia-Canary-${version}.AppImage`,
      dmg: `Inertia-Canary-${version}-${architecture}.dmg`,
      zip: `Inertia-Canary-${version}-${architecture}.zip`,
    };
  }
  return {
    appImage: architecture === "arm64"
      ? `Inertia-${version}-arm64.AppImage`
      : `Inertia-${version}.AppImage`,
    dmg: architecture === "arm64"
      ? `Inertia-${version}-arm64.dmg`
      : `Inertia-${version}.dmg`,
    zip: architecture === "arm64"
      ? `Inertia-${version}-arm64-mac.zip`
      : `Inertia-${version}-mac.zip`,
  };
}

export function unversionedAppImageDependencies(dynamicSection) {
  return [...dynamicSection.matchAll(/Shared library: \[([^\]]+)\]/gu)]
    .map((match) => match[1])
    .filter((name) => name === "libz.so");
}

async function requireNativeFiles(paths, platform) {
  for (const path of paths) {
    await requireRegularFile(path);
    await inspectNativeBinaryArchitecture(path, {
      expectedArchitecture: process.arch,
      platform,
    });
  }
  console.log(`Release container native binaries verified (${paths.length}, ${platform}/${process.arch}).`);
}

function nativeModulePaths(resources, platform, productName, app) {
  const unpacked = join(resources, "app.asar.unpacked", "node_modules");
  const claudePlatform = platform === "darwin" ? "darwin" : "linux";
  const canvasPlatform = platform === "darwin" ? "darwin" : "linux";
  const platformPaths = platform === "darwin"
    ? [
        join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"),
        join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Helpers", "chrome_crashpad_handler"),
        ...["libEGL.dylib", "libGLESv2.dylib", "libffmpeg.dylib", "libvk_swiftshader.dylib"]
          .map((name) => join(
            app,
            "Contents",
            "Frameworks",
            "Electron Framework.framework",
            "Versions",
            "A",
            "Libraries",
            name,
          )),
        ...["Mantle", "ReactiveObjC", "Squirrel"].map((name) => join(
          app,
          "Contents",
          "Frameworks",
          `${name}.framework`,
          "Versions",
          "A",
          name,
        )),
        join(
          app,
          "Contents",
          "Frameworks",
          "Squirrel.framework",
          "Versions",
          "A",
          "Resources",
          "ShipIt",
        ),
        ...["", " (GPU)", " (Plugin)", " (Renderer)"].map((suffix) => join(
          app,
          "Contents",
          "Frameworks",
          `${productName} Helper${suffix}.app`,
          "Contents",
          "MacOS",
          `${productName} Helper${suffix}`,
        )),
      ]
    : [
        join(app, "chrome-sandbox"),
        join(app, "chrome_crashpad_handler"),
        ...["libEGL.so", "libGLESv2.so", "libffmpeg.so", "libvk_swiftshader.so", "libvulkan.so.1"]
          .map((name) => join(app, name)),
      ];
  return [
    ...platformPaths,
    join(unpacked, `@anthropic-ai/claude-agent-sdk-${claudePlatform}-${process.arch}/claude`),
    join(
      unpacked,
      platform === "darwin"
        ? `@napi-rs/canvas-${canvasPlatform}-${process.arch}/skia.${canvasPlatform}-${process.arch}.node`
        : `@napi-rs/canvas-${canvasPlatform}-${process.arch}-gnu/skia.${canvasPlatform}-${process.arch}-gnu.node`,
    ),
    join(unpacked, `better-sqlite3/prebuilds/${platform === "darwin" ? "darwin" : "linux"}-${process.arch}.node`),
    join(unpacked, "node-pty", "build", "Release", "pty.node"),
    ...(platform === "darwin"
      ? [join(unpacked, "node-pty", "build", "Release", "spawn-helper")]
      : []),
  ];
}

async function runPackageSmoke(
  repositoryRoot,
  executable,
  resources,
  packageKind,
  supervisorRoot,
  extraEnvironment = {},
  unsetEnvironment = [],
) {
  const environment = {
    ...process.env,
    ...extraEnvironment,
    INERTIA_PACKAGE_SMOKE_EXECUTABLE: executable,
    INERTIA_PACKAGE_SMOKE_INHERIT_PROCESS_GROUP: "1",
    INERTIA_PACKAGE_SMOKE_KIND: packageKind,
    INERTIA_PACKAGE_SMOKE_RESOURCES: resources,
    INERTIA_PACKAGE_SMOKE_SUPERVISOR_ROOT: supervisorRoot,
  };
  for (const name of unsetEnvironment) delete environment[name];
  await runContainerCommand(process.execPath, [join(repositoryRoot, "scripts", "package-smoke.mjs")], {
    cwd: repositoryRoot,
    echoOutput: true,
    env: environment,
    label: `${packageKind} application smoke`,
    timeoutMs: PACKAGE_SMOKE_TIMEOUT_MS,
  });
}

async function smokeMacContainer(repositoryRoot, container, kind, temporaryRoot, productName) {
  const requestedExtractionRoot = join(temporaryRoot, kind);
  await mkdir(requestedExtractionRoot, { recursive: true });
  const extractionRoot = await realpath(requestedExtractionRoot);
  let mountAttempted = false;
  let operationError;
  try {
    if (kind === "macos-zip") {
      await runContainerCommand("ditto", ["-x", "-k", container, extractionRoot], {
        label: "macOS ZIP extraction",
      });
    } else {
      await runContainerCommand("hdiutil", ["verify", container], { label: "macOS DMG verification" });
      mountAttempted = true;
      await runContainerCommand("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", extractionRoot, container], {
        label: "macOS DMG mount",
      });
    }
    const app = join(extractionRoot, `${productName}.app`);
    const executable = join(app, "Contents", "MacOS", productName);
    const resources = join(app, "Contents", "Resources");
    await requireRegularFile(executable, true);
    await requireNativeFiles(
      [executable, ...nativeModulePaths(resources, "darwin", productName, app)],
      "darwin",
    );
    await runContainerCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
      label: `${kind} complete bundle signature`,
    });
    await runPackageSmoke(repositoryRoot, executable, resources, kind, temporaryRoot);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (mountAttempted) {
      if (operationError?.preserveTemporaryRoot === true) {
        console.error(`Preserved mounted macOS smoke root after unconfirmed process cleanup: ${extractionRoot}.`);
      } else {
        await reconcileMacImageMount(extractionRoot);
      }
    }
  }
}

async function smokeMac(repositoryRoot, releaseDirectory, names, productName) {
  const dmg = join(releaseDirectory, names.dmg);
  const zip = join(releaseDirectory, names.zip);
  await requireRegularFile(dmg);
  await requireRegularFile(zip);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-mac-container-smoke-"));
  let operationError;
  try {
    await smokeMacContainer(repositoryRoot, zip, "macos-zip", temporaryRoot, productName);
    await smokeMacContainer(repositoryRoot, dmg, "macos-dmg", temporaryRoot, productName);
    console.log(`macOS ${process.arch} ZIP and DMG container smoke passed.`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (operationError?.preserveTemporaryRoot === true) {
      console.error(`Preserved macOS release-container smoke root: ${temporaryRoot}.`);
    } else {
      await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    }
  }
}

async function smokeLinux(repositoryRoot, releaseDirectory, names, productName) {
  const appImage = join(releaseDirectory, names.appImage);
  await requireRegularFile(appImage, true);
  await inspectNativeBinaryArchitecture(appImage, {
    expectedArchitecture: process.arch,
    platform: "linux",
  });
  const dynamicSection = await runContainerCommand("readelf", ["-d", appImage], {
    label: "AppImage runtime dependency inspection",
  });
  const unsafeDependencies = unversionedAppImageDependencies(dynamicSection);
  if (unsafeDependencies.length > 0) {
    throw new Error(`The AppImage runtime requires unsafe unversioned dependencies: ${unsafeDependencies.join(", ")}.`);
  }
  await runContainerCommand(appImage, ["--appimage-version"], {
    label: "AppImage runtime entry",
    echoOutput: true,
  });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-appimage-container-smoke-"));
  let operationError;
  try {
    await runContainerCommand(appImage, ["--appimage-extract"], {
      cwd: temporaryRoot,
      label: "AppImage wrapper extraction",
    });
    const app = join(temporaryRoot, "squashfs-root");
    const embeddedExecutable = join(app, productName === "Inertia Canary" ? "inertia-canary" : "inertia");
    const resources = join(app, "resources");
    await requireNativeFiles(
      [embeddedExecutable, ...nativeModulePaths(resources, "linux", productName, app)],
      "linux",
    );
    await runPackageSmoke(repositoryRoot, appImage, resources, "linux-appimage", temporaryRoot, {
      INERTIA_PACKAGE_SMOKE_NO_SANDBOX: "1",
    }, ["APPIMAGE_EXTRACT_AND_RUN"]);
    console.log(`Linux ${process.arch} AppImage default mount/AppRun smoke passed.`);
    await runPackageSmoke(repositoryRoot, appImage, resources, "linux-appimage", temporaryRoot, {
      APPIMAGE_EXTRACT_AND_RUN: "1",
      INERTIA_PACKAGE_SMOKE_NO_SANDBOX: "1",
    });
    console.log(`Linux ${process.arch} AppImage extract-and-run fallback smoke passed.`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (operationError?.preserveTemporaryRoot === true) {
      console.error(`Preserved Linux release-container smoke root: ${temporaryRoot}.`);
    } else {
      await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    }
  }
}

export async function main() {
  if (!ARCHITECTURES.has(process.arch)) {
    throw new Error(`The release container smoke does not support ${process.arch}.`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("The release container smoke must run on macOS or Linux.");
  }
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const manifest = (await import(join(repositoryRoot, "package.json"), { with: { type: "json" } })).default;
  const channel = process.env.INERTIA_RELEASE_CHANNEL ?? "stable";
  const names = releaseContainerNames(manifest.version, channel, process.arch);
  const productName = channel === "canary" ? "Inertia Canary" : "Inertia";
  const releaseDirectory = join(repositoryRoot, "release");
  if (process.platform === "darwin") {
    await smokeMac(repositoryRoot, releaseDirectory, names, productName);
  } else {
    await smokeLinux(repositoryRoot, releaseDirectory, names, productName);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
