import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (contents.includes(needle)) matches.push(path);
  }
  return matches;
}
