import { statSync } from "node:fs";
import { resolve } from "node:path";

import { RuntimeRequestError } from "./runtime-errors";

export function requireRuntimeDirectory(path: string): string {
  const absolutePath = resolve(path);
  try {
    if (!statSync(absolutePath).isDirectory()) throw new Error();
  } catch {
    throw new RuntimeRequestError("Project path must be an existing directory.");
  }
  return absolutePath;
}

export function projectActionCommand(manager: string, actionId: string): string {
  if (!/^[A-Za-z0-9:_-]+$/u.test(actionId)) {
    throw new RuntimeRequestError("This package script name cannot be run safely from the terminal.");
  }
  if (manager === "yarn") return `yarn ${actionId}`;
  if (manager === "pnpm") return `pnpm run ${actionId}`;
  if (manager === "bun") return `bun run ${actionId}`;
  return `npm run ${actionId}`;
}
