import { readFileSync } from "node:fs";

export function readSourceText(path: string | URL): string {
  return readFileSync(path, "utf8").replace(/\r\n?/gu, "\n");
}
