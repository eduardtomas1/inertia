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

export function packageSmokeEnvironment(): {
  marker: string | null;
  codexExecutable: string | null;
  pdfInput: string | null;
  pdfResult: string | null;
  imageInput: string | null;
  imageResult: string | null;
} {
  return {
    marker: absoluteTestPath("INERTIA_PACKAGE_SMOKE_FILE"),
    codexExecutable: absoluteTestPath("INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED"),
    pdfInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_INPUT"),
    pdfResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_RESULT"),
    imageInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_INPUT"),
    imageResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_RESULT"),
  };
}
