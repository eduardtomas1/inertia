import { createHash } from "node:crypto";
import { fstatSync, readSync, writeFileSync } from "node:fs";
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
  namedAppImagePath: string | null;
  appImageFileDescriptor: 4 | null;
  appImageFileDescriptorIdentity: PackageSmokeFileDescriptorIdentity | null;
} {
  const marker = absoluteTestPath("INERTIA_PACKAGE_SMOKE_FILE");
  const token = ownerToken();
  const appImageFileDescriptor = marker
      && token
      && process.env.INERTIA_PACKAGE_SMOKE_EXPECT_APPIMAGE_FD === "4"
    ? 4 as const
    : null;
  const namedAppImagePath = appImageFileDescriptor === 4
    ? absoluteTestPath("INERTIA_PACKAGE_SMOKE_NAMED_APPIMAGE")
    : null;
  return {
    marker,
    ownerToken: token,
    codexExecutable: absoluteTestPath("INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED"),
    pdfInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_INPUT"),
    pdfResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_PDF_RESULT"),
    imageInput: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_INPUT"),
    imageResult: absoluteTestPath("INERTIA_PACKAGE_SMOKE_IMAGE_RESULT"),
    namedAppImagePath,
    appImageFileDescriptor,
    appImageFileDescriptorIdentity:
      packageSmokeFileDescriptorIdentity(appImageFileDescriptor),
  };
}

export interface PackageSmokeFileDescriptorIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly sha256: string;
}

export function packageSmokeFileDescriptorIdentity(
  fileDescriptor: 4 | null,
): PackageSmokeFileDescriptorIdentity | null {
  if (fileDescriptor === null) return null;
  try {
    const metadata = fstatSync(fileDescriptor, { bigint: true });
    if (
      !metadata.isFile()
      || metadata.size <= 0n
      || metadata.size > 4n * 1_024n * 1_024n * 1_024n
    ) return null;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1_024 * 1_024);
    const size = Number(metadata.size);
    let position = 0;
    while (position < size) {
      const bytesRead = readSync(
        fileDescriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, size - position),
        position,
      );
      if (bytesRead <= 0) return null;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const confirmed = fstatSync(fileDescriptor, { bigint: true });
    if (
      confirmed.dev !== metadata.dev
      || confirmed.ino !== metadata.ino
      || confirmed.size !== metadata.size
      || confirmed.mode !== metadata.mode
      || confirmed.mtimeNs !== metadata.mtimeNs
      || confirmed.ctimeNs !== metadata.ctimeNs
    ) return null;
    return Object.freeze({
      device: metadata.dev.toString(10),
      inode: metadata.ino.toString(10),
      size: metadata.size.toString(10),
      sha256: digest.digest("hex"),
    });
  } catch {
    return null;
  }
}

export const initialPackageSmokeEnvironment = packageSmokeEnvironment();
if (initialPackageSmokeEnvironment.namedAppImagePath) {
  // AppImage runtimes commonly rewrite APPIMAGE to /proc/self/fd/4. The
  // authenticated final-package sentinel mirrors restricted bootstrap by
  // retaining its separately bounded original candidate path.
  process.env.APPIMAGE = initialPackageSmokeEnvironment.namedAppImagePath;
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
