import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AttachmentImportValidationError,
  validateAttachmentImportFile,
  type AttachmentImportFileOperation,
} from "../../src/main/attachment-import-file";
import {
  overlappingXlsxFixture,
  truncatedPdfFixture,
  truncatedXlsxFixture,
  validXlsxFixture,
} from "../fixtures/attachments/malicious-structures";

const directories: string[] = [];

function readablePdf(): Buffer {
  const records = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let source = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, body] of records.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${records.length + 1}\n`;
  source += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${records.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

async function stage(
  name: string,
  mimeType: string,
  bytes: Buffer,
  stallBeforeValidationMs = 0,
): Promise<{ operation: AttachmentImportFileOperation; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-import-validation-"));
  directories.push(root);
  await chmod(root, 0o700);
  const canonicalRoot = await realpath(root);
  const info = await lstat(canonicalRoot, { bigint: true });
  const extension = name.split(".").at(-1)!;
  const fileName = `11111111-1111-4111-8111-111111111111.${extension}`;
  const path = join(canonicalRoot, fileName);
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    path,
    operation: {
      root: canonicalRoot,
      rootDev: String(info.dev),
      rootIno: String(info.ino),
      rootUid: process.platform === "win32" ? null : String(info.uid),
      fileName,
      name,
      mimeType,
      size: bytes.length,
      stallBeforeValidationMs,
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })));
});

describe("private staged attachment validation", () => {
  it.each([
    {
      name: "brief.pdf",
      mimeType: "application/pdf",
      bytes: readablePdf,
    },
    {
      name: "forecast.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: validXlsxFixture,
    },
  ])("validates a pinned $name capability", async (fixture) => {
    const { operation } = await stage(
      fixture.name,
      fixture.mimeType,
      fixture.bytes(),
    );

    await expect(validateAttachmentImportFile(operation)).resolves.toMatchObject({
      displayName: fixture.name,
      mimeType: fixture.mimeType,
      size: operation.size,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it.each([
    ["truncated.pdf", "application/pdf", truncatedPdfFixture],
    [
      "truncated.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      truncatedXlsxFixture,
    ],
    [
      "overlapping.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      overlappingXlsxFixture,
    ],
  ])("rejects the hostile %s fixture", async (name, mimeType, fixture) => {
    const { operation } = await stage(name, mimeType, fixture());

    await expect(validateAttachmentImportFile(operation)).rejects.toMatchObject({
      code: "content",
    } satisfies Partial<AttachmentImportValidationError>);
  });

  it("rejects a symlink substituted for the staged capability", async () => {
    const bytes = readablePdf();
    const { operation, path } = await stage(
      "brief.pdf",
      "application/pdf",
      bytes,
    );
    const outside = join(operation.root, "outside.pdf");
    await writeFile(outside, bytes, { mode: 0o600 });
    await rm(path);
    await symlink(outside, path);

    await expect(validateAttachmentImportFile(operation)).rejects.toMatchObject({
      code: "unsafe",
    } satisfies Partial<AttachmentImportValidationError>);
  });

  it("detects same-size mutation during the worker validation race", async () => {
    const bytes = readablePdf();
    const { operation, path } = await stage(
      "brief.pdf",
      "application/pdf",
      bytes,
      50,
    );
    const validation = expect(
      validateAttachmentImportFile(operation),
    ).rejects.toMatchObject({ code: "unsafe" });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    const replacement = Buffer.from(bytes);
    replacement[replacement.length - 1] ^= 0x01;
    await writeFile(path, replacement, { mode: 0o600 });

    await validation;
  });

  it("cancels a delayed validation without publishing a receipt", async () => {
    const { operation } = await stage(
      "brief.pdf",
      "application/pdf",
      readablePdf(),
      1_000,
    );
    const controller = new AbortController();
    const validation = validateAttachmentImportFile(operation, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(validation).rejects.toThrow(/abort/u);
  });
});
