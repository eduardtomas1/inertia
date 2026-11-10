import { createHash } from "node:crypto";
import { win32 } from "node:path";

export function agentSecretDataPath(input: {
  platform: NodeJS.Platform;
  dataDirectory: string;
  userDataPath: string;
}): string {
  if (input.platform !== "win32") return input.dataDirectory;
  const dataDirectory = win32.resolve(input.dataDirectory).toLowerCase();
  const userData = win32.resolve(input.userDataPath).toLowerCase();
  if (dataDirectory === userData || dataDirectory.startsWith(`${userData}\\`)) return input.dataDirectory;
  const key = createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16);
  return win32.join(input.userDataPath, "private", key);
}
