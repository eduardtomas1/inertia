import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LinuxSecretService {
  environment: Record<string, string>;
  electronMainEntry: string;
  close: () => Promise<void>;
}

// Exercise Electron's real encrypted vault on headless Linux. A private bus,
// HOME and XDG directories prevent discovery or unlocking of a desktop keyring.
// Both daemons stay in the foreground; only these exact children are stopped.
export async function createLinuxSecretService(): Promise<LinuxSecretService | undefined> {
  if (process.platform !== "linux") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "inertia-limits-keyring-"));
  const environment = {
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_RUNTIME_DIR: join(directory, "runtime"),
    XDG_CURRENT_DESKTOP: "GNOME",
    GNOME_KEYRING_CONTROL: join(directory, "control"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, "bus")}`,
  };
  const env = { ...process.env, ...environment };
  const electronMainEntry = join(directory, "electron-main.cjs");
  const children: ChildProcess[] = [];
  let startupError: Error | undefined;
  const start = (file: string, args: string[]): ChildProcess => {
    const child = spawn(file, args, { env, shell: false, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) => { startupError = error; });
    child.stdin.on("error", () => { /* Startup/exit checks report a failed daemon. */ });
    children.push(child);
    return child;
  };
  const close = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const child of children.toReversed()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => { clearTimeout(killTimer); clearTimeout(deadlineTimer); resolve(); };
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        const deadlineTimer = setTimeout(() => {
          child.removeListener("exit", finish);
          reject(new Error("Private credential daemon did not exit after SIGKILL"));
        }, 4_000);
        child.once("exit", finish);
        child.kill("SIGTERM");
      }).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw new AggregateError(failures, "Private credential daemon cleanup failed");
    await rm(directory, { recursive: true, force: true });
  };
  const call = async (destination: string, path: string, method: string, ...args: string[]): Promise<string> => {
    const { stdout } = await run("dbus-send", [
      "--session", "--print-reply", "--reply-timeout=1000", `--dest=${destination}`, path, method, ...args,
    ], { env, timeout: 2_000, maxBuffer: 4_096, killSignal: "SIGKILL" });
    return stdout;
  };
  try {
    for (const path of [environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.XDG_RUNTIME_DIR, environment.GNOME_KEYRING_CONTROL]) {
      await mkdir(path, { mode: 0o700 });
    }
    // Playwright's Electron loader forces --password-store=basic after parsing
    // launch args. Select the real store in a test-only entrypoint before the
    // built app is imported, preserving its normal application/resource path.
    await writeFile(electronMainEntry, [
      'const { app } = require("electron");',
      'app.commandLine.appendSwitch("password-store", "gnome-libsecret");',
      `app.setAppPath(${JSON.stringify(process.cwd())});`,
      `require(${JSON.stringify(join(process.cwd(), "out", "main", "index.js"))});`,
    ].join("\n"), { mode: 0o600 });
    start("dbus-daemon", ["--session", "--nofork", `--address=${environment.DBUS_SESSION_BUS_ADDRESS}`]);
    const deadline = Date.now() + 10_000;
    // Wait for the private bus before starting the daemon: otherwise libsecret
    // can try session autolaunch instead of connecting to the owned bus.
    while (true) {
      if (startupError) throw startupError;
      try { await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"); break; }
      catch { if (Date.now() >= deadline) throw new Error("Private D-Bus did not become ready"); }
      await delay(50);
    }
    const keyring = start("gnome-keyring-daemon", ["--foreground", "--components=secrets", "--unlock", "--control-directory", environment.GNOME_KEYRING_CONTROL]);
    // A nonempty throwaway password travels only over stdin, never argv or logs.
    keyring.stdin!.end(randomBytes(32).toString("hex"));
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) throw new Error("Private credential daemon exited during startup");
      try {
        const owner = await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets");
        if (owner.includes("boolean true")) {
          const alias = await call("org.freedesktop.secrets", "/org/freedesktop/secrets", "org.freedesktop.Secret.Service.ReadAlias", "string:default");
          if (alias.includes('object path "/org/freedesktop/secrets/collection/login"')) return { environment, electronMainEntry, close };
        }
      } catch { /* The daemon may still be creating its login collection. */ }
      await delay(50);
    }
    throw new Error("Private Secret Service did not become ready");
  } catch (cause) {
    await close();
    throw new Error("Linux credential E2E requires dbus-daemon, dbus-bin and gnome-keyring with an unlocked private login collection.", { cause });
  }
}
