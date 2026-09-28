import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import {
  fixtureCaptureWriterSource,
  portableFixtureRoot,
  readStableFixtureCapture,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";

type CaptureWriter = (value: unknown) => void;

function captureWriter(capturePath: string, renameSync: typeof fs.renameSync): CaptureWriter {
  return runInNewContext(fixtureCaptureWriterSource(capturePath), {
    fs: { ...fs, renameSync },
  }) as CaptureWriter;
}

function failingRename(code: string): typeof fs.renameSync {
  return () => {
    throw Object.assign(new Error(`Injected ${code} from rename.`), { code });
  };
}

describe("fixture capture writer", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  function capturePath(): string {
    const root = portableFixtureRoot("fixture capture writer");
    roots.push(root);
    return join(root, "capture.json");
  }

  it("replaces the capture through the staged file", () => {
    const path = capturePath();
    writeFileSync(path, JSON.stringify({ captured: ["old"] }));

    captureWriter(path, fs.renameSync)({ captured: ["new"] });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ captured: ["new"] });
    expect(existsSync(`${path}.next`)).toBe(false);
  });

  it.each(["EEXIST", "EPERM"])("lands a complete capture when rename reports %s", (code) => {
    const path = capturePath();
    writeFileSync(path, JSON.stringify({ captured: ["old"] }));
    const write = captureWriter(path, failingRename(code));

    write({ port: 1, captured: ["first"] });
    write({ port: 1, captured: ["first", "second"] });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ port: 1, captured: ["first", "second"] });
    expect(existsSync(`${path}.next`)).toBe(false);
    expect(readStableFixtureCapture(path)).toEqual({ port: 1, captured: ["first", "second"] });
  });

  it("does not hide other rename failures", () => {
    const path = capturePath();

    expect(() => captureWriter(path, failingRename("EACCES"))({ captured: [] }))
      .toThrow("Injected EACCES from rename.");
  });
});
