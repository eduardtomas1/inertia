import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeDiagnostics,
  runtimeDiagnosticsDirectory,
  sanitizeRuntimeDiagnosticText,
} from "../../src/main/runtime-diagnostics";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-runtime-diagnostics-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime diagnostics", () => {
  it("logs only allowlisted lifecycle fields and redacts unsafe failure values", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.record("runtime.failure", {
      phase: "restarting",
      generation: 2,
      message: "prompt='rewrite secret' source=/home/alice/private.ts token=ghp_1234567890 password=hunter2 user=dev@example.com",
      prompt: "must never be serialized",
      source: "export const secret = true",
      tokens: 1234,
      credential: "hunter2",
      websocketUrl: "ws://127.0.0.1/runtime/sensitive-capability",
    });

    const content = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(content).toContain('"event":"runtime.failure"');
    expect(content).toContain('"phase":"restarting"');
    expect(content).not.toContain("rewrite secret");
    expect(content).not.toContain("private.ts");
    expect(content).not.toContain("ghp_1234567890");
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("dev@example.com");
    expect(content).not.toContain("must never be serialized");
    expect(content).not.toContain("export const secret");
    expect(content).not.toContain("1234");
    expect(content).not.toContain("sensitive-capability");
    expect(content).not.toMatch(/prompt|source|tokens?|credential/iu);
  });

  it("redacts credentials, content-shaped fields, paths, and control characters", () => {
    const sanitized = sanitizeRuntimeDiagnosticText(
      "Bearer abc.def prompt:hello source='private code' tokens=987 credential=my-secret at C:\\Users\\Alice\\project and /tmp/inertia/source.ts\u0000",
    );
    expect(sanitized).not.toContain("abc.def");
    expect(sanitized).not.toContain("hello");
    expect(sanitized).not.toContain("private code");
    expect(sanitized).not.toContain("987");
    expect(sanitized).not.toContain("my-secret");
    expect(sanitized).not.toContain("Alice");
    expect(sanitized).not.toContain("source.ts");
    expect(sanitized).not.toContain("\u0000");
  });

  it("rotates within fixed file and byte bounds and removes expired generations", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const now = Date.now();
    const diagnostics = new RuntimeDiagnostics(directory, {
      maxFileBytes: 480,
      maxFiles: 3,
      retentionMs: 60_000,
      now: () => now,
    });
    diagnostics.ensureDirectory();
    const expired = join(directory, "runtime.2.log");
    writeFileSync(expired, "{\"event\":\"expired\"}\n", { mode: 0o600 });
    const old = new Date(now - 120_000);
    utimesSync(expired, old, old);

    for (let index = 0; index < 40; index += 1) {
      diagnostics.record("runtime.failure", { phase: "restarting", generation: index, message: "bounded failure detail" });
    }

    const files = readdirSync(directory).filter((name) => name.endsWith(".log")).sort();
    expect(files).toEqual(["runtime.1.log", "runtime.2.log", "runtime.log"]);
    expect(files.every((name) => statSync(join(directory, name)).size <= 480)).toBe(true);
    if (process.platform !== "win32") {
      expect(files.every((name) => (statSync(join(directory, name)).mode & 0o777) === 0o600)).toBe(true);
    }
    expect(files.map((name) => readFileSync(join(directory, name), "utf8")).join("")).not.toContain("expired");
  });

  it("uses a dedicated directory with private directory and file permissions", () => {
    if (process.platform === "win32") return;
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.record("app.start");

    expect(directory).toBe(join(root, "logs", "runtime"));
    expect(statSync(directory).isDirectory()).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "runtime.log")).mode & 0o777).toBe(0o600);

    chmodSync(directory, 0o755);
    diagnostics.ensureDirectory();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});
