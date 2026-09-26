import { posix, win32 } from "node:path";

export const TEST_PROVIDER_BIN_DIRECTORY_ENVIRONMENT_KEY =
  "INERTIA_TEST_PROVIDER_BIN_DIR";

export function isTestProviderBinDirectory(
  value: string | undefined,
  platform: NodeJS.Platform,
): value is string {
  return typeof value === "string"
    && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && (platform === "win32" ? win32 : posix).isAbsolute(value);
}
