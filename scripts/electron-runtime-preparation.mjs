import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const executablePaths = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  win32: "electron.exe",
};
const pinnedEnvironmentKeys = new Set([
  "electron_install_platform", "electron_install_arch",
  "npm_config_platform", "npm_config_arch",
]);
const forbiddenOverrides = new Set([
  "electronoverridedistpath",
  "electronuseremotechecksums", "npmconfigelectronuseremotechecksums",
  "electroncustomversion", "npmconfigelectroncustomversion",
  "npmpackageconfigelectroncustomversion",
]);

function installerEnvironment(environment, platform, arch) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value && forbiddenOverrides.has(name.toLowerCase().replaceAll("_", ""))) {
      throw new Error(`Electron runtime preparation rejects ${name}.`);
    }
    if (!pinnedEnvironmentKeys.has(name.toLowerCase())) result[name] = value;
  }
  return {
    ...result,
    ELECTRON_INSTALL_PLATFORM: platform,
    ELECTRON_INSTALL_ARCH: arch,
    npm_config_platform: platform,
    // Also suppress the installer's implicit Rosetta architecture switch.
    npm_config_arch: arch,
  };
}

function checkPath(path, directory, required = true) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata && !required) return null;
  if (!metadata || metadata.isSymbolicLink()
    || !(directory ? metadata.isDirectory() : metadata.isFile())) {
    throw new Error(`Electron runtime preparation requires a regular ${directory ? "directory" : "file"}: ${path}`);
  }
  return metadata;
}

function readMetadata(path) {
  const metadata = checkPath(path, false);
  if (metadata.size < 1 || metadata.size > 64 * 1024) {
    throw new Error(`Electron runtime metadata is empty or oversized: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/** The caller owns bounded process launch, cancellation, lock and quarantine. */
export async function prepareElectronRuntime({
  root, run, environment = process.env, platform = process.platform, arch = process.arch,
}) {
  const env = installerEnvironment(environment, platform, arch);
  const executable = executablePaths[platform];
  if (!isAbsolute(root) || !executable) {
    throw new Error("Electron runtime preparation requires an absolute root and a supported platform.");
  }
  const projectDirectory = realpathSync(root);
  const packageDirectory = join(projectDirectory, "node_modules", "electron");
  checkPath(join(projectDirectory, "node_modules"), true);
  checkPath(packageDirectory, true);
  const installed = JSON.parse(readMetadata(join(packageDirectory, "package.json")));
  if (installed.name !== "electron" || typeof installed.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(installed.version)) {
    throw new Error("The installed Electron package identity is invalid.");
  }
  const checksums = JSON.parse(readMetadata(join(packageDirectory, "checksums.json")));
  const artifact = `electron-v${installed.version}-${platform}-${arch === "arm" ? "armv7l" : arch}.zip`;
  if (!/^[a-f0-9]{64}$/u.test(checksums?.[artifact] ?? "")) {
    throw new Error("The installed Electron package has no checksum for the requested runtime.");
  }
  const installer = join(packageDirectory, "install.js");
  checkPath(installer, false);
  const distribution = join(packageDirectory, "dist");
  const pathFile = join(packageDirectory, "path.txt");
  const requiredFiles = ["version", "LICENSE", "LICENSES.chromium.html", executable];
  // Reject redirected write locations before the official installer executes.
  checkPath(distribution, true, false);
  checkPath(pathFile, false, false);
  for (const file of requiredFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      checkPath(join(distribution, ...parts.slice(0, index)), true, false);
    }
    checkPath(join(distribution, file), false, false);
  }
  await run({
    command: process.execPath,
    args: [installer],
    env,
    label: "Electron runtime preparation",
    // Download and extraction are bounded independently from packaging.
    timeoutMs: 10 * 60_000,
  });
  checkPath(distribution, true);
  if (readMetadata(pathFile) !== executable
    || readMetadata(join(distribution, "version")).replace(/^v/u, "") !== installed.version) {
    throw new Error("The prepared Electron runtime version or executable path does not match its installed package.");
  }
  for (const file of requiredFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      checkPath(join(distribution, ...parts.slice(0, index)), true);
    }
    if (checkPath(join(distribution, file), false).size === 0) {
      throw new Error(`The prepared Electron runtime resource is empty: ${file}`);
    }
  }
}
