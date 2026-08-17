import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { AppUpdateDeliveryReason } from "../shared/desktop.js";
import type { AppUpdateCapability } from "./app-update.js";

const MAX_PACKAGE_JSON_BYTES = 256 * 1_024;
const MANUAL_REASONS = new Set<AppUpdateDeliveryReason>([
  "development-build",
  "capability-missing",
  "capability-invalid",
  "platform-mismatch",
  "macos-signing-unavailable",
  "windows-signing-unavailable",
]);

interface CapabilityOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appPath: string;
  appImagePath?: string;
}

function manual(reason: AppUpdateDeliveryReason): AppUpdateCapability {
  return { delivery: "manual", reason };
}

function packageMarker(appPath: string): unknown {
  try {
    const path = join(appPath, "package.json");
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > MAX_PACKAGE_JSON_BYTES) return null;
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      inertiaUpdateCapability?: unknown;
    };
    return manifest.inertiaUpdateCapability;
  } catch {
    return null;
  }
}

function linuxAppImageCapability(appImagePath: string | undefined): AppUpdateCapability {
  if (!appImagePath || !isAbsolute(appImagePath)) return manual("appimage-unavailable");
  try {
    const metadata = lstatSync(appImagePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return manual("appimage-invalid");
    const actualPath = realpathSync(appImagePath);
    accessSync(actualPath, constants.W_OK);
    accessSync(dirname(actualPath), constants.W_OK);
    return { delivery: "in-app" };
  } catch {
    return manual("appimage-not-replaceable");
  }
}

/** Fail closed unless the packaged artifact explicitly attests update support. */
export function resolveAppUpdateCapability(options: CapabilityOptions): AppUpdateCapability {
  if (!options.isPackaged) return manual("development-build");
  const marker = packageMarker(options.appPath);
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return manual("capability-missing");
  }
  const candidate = marker as { delivery?: unknown; platform?: unknown; reason?: unknown };
  const keys = Object.keys(marker).sort();
  if (candidate.delivery === "manual") {
    return keys.length === 2
      && keys[0] === "delivery"
      && keys[1] === "reason"
      && typeof candidate.reason === "string" && MANUAL_REASONS.has(
      candidate.reason as AppUpdateDeliveryReason,
    )
      ? manual(candidate.reason as AppUpdateDeliveryReason)
      : manual("capability-invalid");
  }
  if (
    candidate.delivery !== "in-app"
    || keys.length !== 2
    || keys[0] !== "delivery"
    || keys[1] !== "platform"
    || !["darwin", "win32", "linux"].includes(String(candidate.platform))
  ) return manual("capability-invalid");
  if (candidate.platform !== options.platform) return manual("platform-mismatch");
  if (options.platform === "linux") {
    return linuxAppImageCapability(options.appImagePath);
  }
  return { delivery: "in-app" };
}
