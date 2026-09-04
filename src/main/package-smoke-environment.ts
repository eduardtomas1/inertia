import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

function absoluteTestPath(name: string): string | null {
  const value = process.env.NODE_ENV === "test" ? process.env[name] : undefined;
  return typeof value === "string"
    && value.length <= 4_096
    && !value.includes("\0")
    && isAbsolute(value)
    ? value
    : null;
}

const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function ownerToken(): string | null {
  const value = process.env.NODE_ENV === "test"
    ? process.env.INERTIA_PACKAGE_SMOKE_OWNER_TOKEN
    : undefined;
  return typeof value === "string" && OWNER_TOKEN_PATTERN.test(value) ? value : null;
}

export function packageSmokeEnvironment(): {
  marker: string | null;
  ownerToken: string | null;
  codexExecutable: string | null;
  pdfInput: string | null;
  pdfResult: string | null;
  imageInput: string | null;
  imageResult: string | null;
} {
  return {
    marker: absoluteTestPath("INERTIA_PACKAGE_SMOKE_FILE"),
    ownerToken: ownerToken(),
    codexExecutable: absoluteTestPath("INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED"),
    pdfInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_INPUT"),
    pdfResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_RESULT"),
    imageInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_INPUT"),
    imageResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_RESULT"),
  };
}

export function writePackageSmokeStage(options: {
  readonly marker: string | null;
  readonly ownerToken: string | null;
  readonly stage: string;
  readonly pid?: number;
}): void {
  if (!options.marker) return;
  try {
    writeFileSync(
      `${options.marker}.${options.stage}.json`,
      JSON.stringify({
        stage: options.stage,
        pid: options.pid ?? process.pid,
        timestampMs: Date.now(),
        ownerToken: options.ownerToken,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch {
    // Packaged smoke diagnostics are best effort and test-only.
  }
}
