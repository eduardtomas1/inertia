import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectNativeBinaryArchitecture } from "./native-binary-architecture.mjs";

const ARCHITECTURES = new Set(["arm64", "x64"]);
const CHANNELS = new Set(["canary", "stable"]);
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const CONTAINER_TIMEOUT_MS = 3 * 60_000;
const PACKAGE_SMOKE_TIMEOUT_MS = 3 * 60_000;

function boundedOutput(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return output.length <= 16 * 1024 ? output : output.slice(-16 * 1024);
}

function runBounded(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    timeout: options.timeoutMs ?? CONTAINER_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = boundedOutput(result);
  if (result.error) {
    throw new Error(`${options.label ?? command} failed to start: ${result.error.message}\n${output}`);
  }
  if (result.status !== 0) {
    throw new Error(`${options.label ?? command} exited with status ${String(result.status)}.\n${output}`);
  }
  if (options.echoOutput && output.trim().length > 0) process.stdout.write(output);
  return result.stdout ?? "";
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

function runPackageSmoke(repositoryRoot, executable, resources, packageKind, extraEnvironment = {}) {
  runBounded(process.execPath, [join(repositoryRoot, "scripts", "package-smoke.mjs")], {
    cwd: repositoryRoot,
    echoOutput: true,
    env: {
      ...process.env,
      ...extraEnvironment,
      INERTIA_PACKAGE_SMOKE_EXECUTABLE: executable,
      INERTIA_PACKAGE_SMOKE_KIND: packageKind,
      INERTIA_PACKAGE_SMOKE_RESOURCES: resources,
    },
    label: `${packageKind} application smoke`,
    timeoutMs: PACKAGE_SMOKE_TIMEOUT_MS,
  });
}

async function smokeMacContainer(repositoryRoot, container, kind, temporaryRoot, productName) {
  const extractionRoot = join(temporaryRoot, kind);
  await mkdir(extractionRoot, { recursive: true });
  let mounted = false;
  try {
    if (kind === "macos-zip") {
      runBounded("ditto", ["-x", "-k", container, extractionRoot], {
        label: "macOS ZIP extraction",
      });
    } else {
      runBounded("hdiutil", ["verify", container], { label: "macOS DMG verification" });
      runBounded("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", extractionRoot, container], {
        label: "macOS DMG mount",
      });
      mounted = true;
    }
    const app = join(extractionRoot, `${productName}.app`);
    const executable = join(app, "Contents", "MacOS", productName);
    const resources = join(app, "Contents", "Resources");
    await requireRegularFile(executable, true);
    await requireNativeFiles(
      [executable, ...nativeModulePaths(resources, "darwin", productName, app)],
      "darwin",
    );
    runBounded("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
      label: `${kind} complete bundle signature`,
    });
    runPackageSmoke(repositoryRoot, executable, resources, kind);
  } finally {
    if (mounted) {
      runBounded("hdiutil", ["detach", extractionRoot, "-force"], {
        label: "macOS DMG detach",
      });
    }
  }
}

async function smokeMac(repositoryRoot, releaseDirectory, names, productName) {
  const dmg = join(releaseDirectory, names.dmg);
  const zip = join(releaseDirectory, names.zip);
  await requireRegularFile(dmg);
  await requireRegularFile(zip);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-mac-container-smoke-"));
  try {
    await smokeMacContainer(repositoryRoot, zip, "macos-zip", temporaryRoot, productName);
    await smokeMacContainer(repositoryRoot, dmg, "macos-dmg", temporaryRoot, productName);
    console.log(`macOS ${process.arch} ZIP and DMG container smoke passed.`);
  } finally {
    await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

async function smokeLinux(repositoryRoot, releaseDirectory, names, productName) {
  const appImage = join(releaseDirectory, names.appImage);
  await requireRegularFile(appImage, true);
  await inspectNativeBinaryArchitecture(appImage, {
    expectedArchitecture: process.arch,
    platform: "linux",
  });
  const dynamicSection = runBounded("readelf", ["-d", appImage], {
    label: "AppImage runtime dependency inspection",
  });
  const unsafeDependencies = unversionedAppImageDependencies(dynamicSection);
  if (unsafeDependencies.length > 0) {
    throw new Error(`The AppImage runtime requires unsafe unversioned dependencies: ${unsafeDependencies.join(", ")}.`);
  }
  runBounded(appImage, ["--appimage-version"], {
    label: "AppImage runtime entry",
    echoOutput: true,
  });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-appimage-container-smoke-"));
  try {
    runBounded(appImage, ["--appimage-extract"], {
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
    runPackageSmoke(repositoryRoot, appImage, resources, "linux-appimage", {
      APPIMAGE_EXTRACT_AND_RUN: "1",
      INERTIA_PACKAGE_SMOKE_NO_SANDBOX: "1",
    });
    console.log(`Linux ${process.arch} AppImage wrapper and application smoke passed.`);
  } finally {
    await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
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
