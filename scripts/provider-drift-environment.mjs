import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const INHERITED_ENVIRONMENT_NAMES = [
  "COMSPEC",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "TERM",
  "TZ",
];

const ISOLATED_PATH_ENVIRONMENT_NAMES = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LOCALAPPDATA",
  "NPM_CONFIG_USERCONFIG",
  "OPENCODE_CONFIG_DIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

export function providerDriftEnvironment(
  isolatedRoot,
  source = process.env,
) {
  const inherited = {};
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) inherited[name] = value;
  }
  const home = join(isolatedRoot, "home");
  const temporary = join(isolatedRoot, "tmp");
  return {
    ...inherited,
    APPDATA: join(isolatedRoot, "appdata"),
    CI: "true",
    CLAUDE_CONFIG_DIR: join(isolatedRoot, "claude-config"),
    HOME: home,
    LOCALAPPDATA: join(isolatedRoot, "local-appdata"),
    NO_COLOR: "1",
    NPM_CONFIG_USERCONFIG: join(isolatedRoot, "npmrc"),
    OPENCODE_CONFIG_DIR: join(isolatedRoot, "opencode-config"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(isolatedRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(isolatedRoot, "xdg-config"),
    XDG_DATA_HOME: join(isolatedRoot, "xdg-data"),
  };
}

export function providerDriftEnvironmentDirectories(environment) {
  return [...new Set([
    environment.APPDATA,
    environment.CLAUDE_CONFIG_DIR,
    environment.HOME,
    environment.LOCALAPPDATA,
    environment.OPENCODE_CONFIG_DIR,
    environment.TMPDIR,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
  ].filter((value) => typeof value === "string" && value.length > 0))];
}

function ownerMatches(metadata) {
  return typeof process.geteuid !== "function" || metadata.uid === process.geteuid();
}

async function preparePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownerMatches(metadata)) {
    throw new Error(process.platform === "win32"
      ? "Provider drift profile path is not a direct directory."
      : "Provider drift profile directory is not owner-private.");
  }
  // POSIX mode bits can establish owner-only access. Node's Windows chmod
  // implementation does not constrain ACLs, so Windows relies on the ACL of
  // the runner-owned temporary root and only validates direct path types here.
  if (process.platform !== "win32") await chmod(path, 0o700);
  const secured = await lstat(path);
  if (process.platform !== "win32" && (secured.mode & 0o077) !== 0) {
    throw new Error("Provider drift profile directory is not owner-private.");
  }
}

async function preparePrivateFile(path) {
  let handle;
  if (process.platform === "win32") {
    try {
      // Node exposes no FILE_FLAG_OPEN_REPARSE_POINT equivalent. Exclusive
      // creation is the only portable way to guarantee an existing junction,
      // symlink, or other reparse target is never followed and truncated.
      handle = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(
          "Provider drift Windows npm profile path must be newly created.",
          { cause: error },
        );
      }
      throw error;
    }
  } else {
    try {
      handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      handle = await open(
        path,
        constants.O_RDWR
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o600,
      );
    }
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownerMatches(metadata)) {
      throw new Error("Provider drift profile file is not owner-private.");
    }
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.sync();
    const secured = await handle.stat();
    if (process.platform !== "win32" && (secured.mode & 0o077) !== 0) {
      throw new Error("Provider drift profile file is not owner-private.");
    }
  } finally {
    await handle.close();
  }
}

export async function prepareProviderDriftEnvironment(
  isolatedRoot,
  environment,
) {
  if (!isAbsolute(isolatedRoot)) {
    throw new Error("Provider drift profile root must be absolute.");
  }
  const expected = providerDriftEnvironment(isolatedRoot, {});
  for (const name of ISOLATED_PATH_ENVIRONMENT_NAMES) {
    if (environment[name] !== expected[name]) {
      throw new Error("Provider drift profile paths must remain isolated.");
    }
  }
  await preparePrivateDirectory(isolatedRoot);
  for (const path of providerDriftEnvironmentDirectories(environment)) {
    await preparePrivateDirectory(path);
  }
  const userConfig = environment.NPM_CONFIG_USERCONFIG;
  if (typeof userConfig !== "string" || !isAbsolute(userConfig)) {
    throw new Error("Provider drift npm profile must be isolated.");
  }
  await preparePrivateFile(userConfig);
}
