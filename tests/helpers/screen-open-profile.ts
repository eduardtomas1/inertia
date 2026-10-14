import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CDPSession, Page } from "@playwright/test";

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.stack",
  "v8.execute",
  "v8",
  "blink",
  "blink.user_timing",
  "loading",
  "toplevel",
];

export interface ScreenOpenProfiler {
  begin: () => Promise<void>;
  end: (name: string) => Promise<void>;
  dispose: () => Promise<void>;
}

async function readStream(session: CDPSession, handle: string): Promise<string> {
  const chunks: string[] = [];
  for (;;) {
    const chunk = await session.send("IO.read", { handle, size: 1 << 20 });
    chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data);
    if (chunk.eof) break;
  }
  await session.send("IO.close", { handle });
  return chunks.join("");
}

export async function createScreenOpenProfiler(
  page: Page,
  directory: string,
): Promise<ScreenOpenProfiler> {
  const session = await page.context().newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  return {
    begin: async () => {
      await session.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: {
          recordMode: "recordAsMuchAsPossible",
          includedCategories: TRACE_CATEGORIES,
        },
      });
      await session.send("Profiler.start");
    },
    end: async (name: string) => {
      const { profile } = await session.send("Profiler.stop");
      const completed = new Promise<string>((resolve, reject) => {
        session.once("Tracing.tracingComplete", (event) => {
          if (event.stream) resolve(event.stream);
          else reject(new Error("The trace did not return a stream."));
        });
      });
      await session.send("Tracing.end");
      const trace = await readStream(session, await completed);
      await Promise.all([
        writeFile(join(directory, `${name}.cpuprofile`), JSON.stringify(profile)),
        writeFile(join(directory, `${name}.trace.json`), trace),
      ]);
    },
    dispose: async () => {
      await session.send("Profiler.disable").catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}
