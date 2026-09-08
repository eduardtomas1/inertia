import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Expand the npm lifecycle as executed, not just the top-level script text. */
function responsibilities(name: string, stack: string[] = []): string[] {
  if (stack.includes(name)) throw new Error(`Cyclic npm lifecycle: ${name}`);
  const command = scripts[name];
  if (!command) throw new Error(`Missing npm command: ${name}`);
  const chain = [...stack, name];
  return [
    ...(scripts[`pre${name}`] ? responsibilities(`pre${name}`, chain) : []),
    ...command.split(" && ").flatMap((step) => {
      const invocation = /^npm run ([a-z:-]+)$/u.exec(step);
      return invocation ? responsibilities(invocation[1]!, chain) : [step];
    }),
    ...(scripts[`post${name}`] ? responsibilities(`post${name}`, chain) : []),
  ];
}

describe("composed verification build ownership", () => {
  it.each(["check", "check:platform"])("%s owns each type/build responsibility once", (name) => {
    const commands = responsibilities(name);
    expect(commands.filter((step) => step === "tsc --noEmit -p src/renderer/private-connect/tsconfig.json"))
      .toHaveLength(1);
    expect(commands.filter((step) => step === "node scripts/build-private-connect.mjs"))
      .toHaveLength(1);
    expect(commands.filter((step) => step === "electron-vite build"))
      .toHaveLength(1);
    const guardian = commands.lastIndexOf("node scripts/build-runtime-process-guardian.mjs");
    expect(guardian).toBeGreaterThanOrEqual(0);
    expect(guardian).toBeLessThan(commands.indexOf("electron-vite build"));
    expect(commands).toContain("node scripts/check-renderer-bundle.mjs");
    expect(commands).toContain("node scripts/verify-database-lineage.mjs");
    expect(commands).toContain("node scripts/check-architecture.mjs");
    expect(commands.includes("vitest run")).toBe(name === "check");
  });

  it("keeps the standalone Private Connect typecheck and actual bundle build", () => {
    expect(responsibilities("check:private-connect")).toEqual([
      "tsc --noEmit -p src/renderer/private-connect/tsconfig.json",
      "node scripts/build-private-connect.mjs",
    ]);
  });

  it("keeps packaged builds and generated notices on the authoritative bundle path", () => {
    const commands = responsibilities("build:packaged");
    expect(commands[0]).toBe("node scripts/generate-third-party-notices.mjs");
    expect(commands.filter((command) => command === "electron-vite build")).toHaveLength(1);
    expect(commands.filter((command) => command === "node scripts/build-private-connect.mjs"))
      .toHaveLength(1);
  });
});
