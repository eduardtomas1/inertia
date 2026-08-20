import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSecureAtomicState,
  writeSecureAtomicState,
} from "../../src/main/secure-atomic-state";

const directories: string[] = [];

function statePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "inertia-secure-state-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json") };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secure atomic state", () => {
  it("enforces byte bounds on reads and writes", () => {
    const { directory, path } = statePath();

    expect(() => writeSecureAtomicState(path, "é", 1)).toThrow(
      "Secure state is too large",
    );
    expect(readdirSync(directory)).toEqual([]);

    writeSecureAtomicState(path, "é", 2);
    expect(readSecureAtomicState(path, 2)).toBe("é");
    expect(readSecureAtomicState(path, 1)).toBeNull();
    expect(() => readSecureAtomicState(path, 0)).toThrow(
      "Invalid secure state size limit",
    );
  });

  it.runIf(process.platform !== "win32")(
    "atomically replaces a regular file with mode 0600",
    () => {
      const { directory, path } = statePath();
      writeFileSync(path, "old", { mode: 0o666 });

      writeSecureAtomicState(path, "new", 16);

      expect(readFileSync(path, "utf8")).toBe("new");
      expect(lstatSync(path).isFile()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory)).toEqual(["state.json"]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "never follows a target symlink for reading or writing",
    () => {
      const { directory, path } = statePath();
      const destination = join(directory, "destination.txt");
      writeFileSync(destination, "private user data", { mode: 0o600 });
      symlinkSync(destination, path);

      expect(readSecureAtomicState(path, 1_024)).toBeNull();
      expect(() => writeSecureAtomicState(path, "replacement", 1_024))
        .toThrow("Unsafe secure state target");
      expect(readFileSync(destination, "utf8")).toBe("private user data");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readdirSync(directory).sort()).toEqual([
        "destination.txt",
        "state.json",
      ]);
    },
  );
});
