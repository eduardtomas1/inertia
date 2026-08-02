import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import type { ChatAttachment } from "../src/shared/contracts";
import { documentAttachmentContexts } from "../src/server/runtime/attachments/document-attachment-context";
import { DocumentExtractionScheduler } from "../src/server/runtime/attachments/document-extraction-scheduler";

interface Metric {
  case: string;
  mode: string;
  wallMs: number;
  cpuMs: number;
  walMiB: number | null;
  peakRssMiB: number;
}

const metrics: Metric[] = [];
const temporaryDirectories: string[] = [];

function measure<T>(operation: () => T): {
  result: T;
  wallMs: number;
  cpuMs: number;
  peakRssMiB: number;
} {
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 1);
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const result = operation();
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  return {
    result,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1_000,
    peakRssMiB: Math.max(0, peakRss - rssBefore) / 1024 / 1024,
  };
}

async function measureAsync<T>(operation: () => Promise<T>): Promise<{
  result: T;
  wallMs: number;
  cpuMs: number;
  peakRssMiB: number;
}> {
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 1);
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  try {
    const result = await operation();
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return {
      result,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      peakRssMiB: Math.max(0, peakRss - rssBefore) / 1024 / 1024,
    };
  } finally {
    clearInterval(sampler);
  }
}

function sqliteCase(mode: "full-copy" | "append-chunks"): Metric {
  const directory = mkdtempSync(join(tmpdir(), `inertia-${mode}-`));
  temporaryDirectories.push(directory);
  const path = join(directory, "stream.sqlite");
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("wal_autocheckpoint = 0");
  database.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
  if (mode === "append-chunks") {
    database.exec(`
      CREATE TABLE chunks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX chunks_message_sequence_idx
        ON chunks(message_id, sequence);
    `);
  }
  database.prepare("INSERT INTO messages (id, content) VALUES ('message', '')").run();
  const deltas = Array.from(
    { length: 512 },
    (_, index) => `${String(index).padStart(4, "0")}:${"x".repeat(507)}`,
  );
  const expected = deltas.join("");
  const measured = measure(() => {
    if (mode === "full-copy") {
      const append = database.prepare(
        "UPDATE messages SET content = content || ? WHERE id = 'message'",
      );
      for (const delta of deltas) append.run(delta);
    } else {
      const append = database.prepare(
        "INSERT INTO chunks (message_id, content) VALUES ('message', ?)",
      );
      for (const delta of deltas) append.run(delta);
      database.transaction(() => {
        database.exec(`
          UPDATE messages SET content = content || (
            SELECT group_concat(content, '') FROM (
              SELECT content FROM chunks ORDER BY sequence
            )
          ) WHERE id = 'message';
          DELETE FROM chunks WHERE message_id = 'message';
        `);
      })();
    }
    return (database.prepare(
      "SELECT content FROM messages WHERE id = 'message'",
    ).get() as { content: string }).content;
  });
  expect(measured.result).toBe(expected);
  const walPath = `${path}-wal`;
  const walMiB = statSync(walPath).size / 1024 / 1024;
  database.close();
  return {
    case: "512 × 512-byte SQLite stream",
    mode,
    wallMs: measured.wallMs,
    cpuMs: measured.cpuMs,
    walMiB,
    peakRssMiB: measured.peakRssMiB,
  };
}

function pdfWithPages(pages: number): Uint8Array {
  const fontId = 3 + pages;
  const contentStart = fontId + 1;
  const pageIds = Array.from({ length: pages }, (_, index) => 3 + index);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`,
  ];
  for (let index = 0; index < pages; index += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentStart + index} 0 R >>`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let index = 0; index < pages; index += 1) {
    const text = `page-${index}-${"selectable text ".repeat(400)}`;
    const stream = `BT /F1 10 Tf 36 740 Td (${text}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function pdfCase(mode: "unbounded-8" | "bounded-2"): Promise<Metric> {
  const bytes = pdfWithPages(32);
  const payloads = Array.from({ length: 8 }, (_, index) => ({
    attachment: {
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `pressure-${index + 1}.pdf`,
      path: `/private/pressure-${index + 1}.pdf`,
      mimeType: "application/pdf",
      size: bytes.byteLength,
    } satisfies ChatAttachment,
    bytes,
  }));
  const scheduler = new DocumentExtractionScheduler({
    concurrency: mode === "unbounded-8" ? 8 : 2,
    maximumWorkingBytes: mode === "unbounded-8"
      ? 20 * 1024 * 1024
      : 12 * 1024 * 1024,
  });
  const measured = await measureAsync(() => documentAttachmentContexts(
    payloads,
    { scheduler, groupId: mode },
  ));
  expect(measured.result).toHaveLength(8);
  return {
    case: "8 × 32-page PDF pressure",
    mode,
    wallMs: measured.wallMs,
    cpuMs: measured.cpuMs,
    walMiB: null,
    peakRssMiB: measured.peakRssMiB,
  };
}

describe("data throughput benchmark", () => {
  it("records full-copy versus bounded append/extraction pressure", async () => {
    // Warm native PDF.js/canvas module loading outside the compared runs.
    const warmBytes = pdfWithPages(1);
    await documentAttachmentContexts([{
      attachment: {
        id: "99999999-1111-4111-8111-111111111111",
        name: "warm.pdf",
        path: "/private/warm.pdf",
        mimeType: "application/pdf",
        size: warmBytes.byteLength,
      },
      bytes: warmBytes,
    }]);
    metrics.push(sqliteCase("full-copy"));
    metrics.push(sqliteCase("append-chunks"));
    metrics.push(await pdfCase("unbounded-8"));
    metrics.push(await pdfCase("bounded-2"));
  });
});

afterAll(() => {
  console.table(metrics.map((metric) => ({
    case: metric.case,
    mode: metric.mode,
    "wall ms": metric.wallMs.toFixed(1),
    "CPU ms": metric.cpuMs.toFixed(1),
    "WAL MiB": metric.walMiB?.toFixed(2) ?? "—",
    "peak RSS +MiB": metric.peakRssMiB.toFixed(2),
  })));
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});
