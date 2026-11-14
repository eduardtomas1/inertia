import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS_MS = Object.freeze([15_000, 45_000, 90_000]);
const { getMakeNsisPath } = createRequire(import.meta.url)("app-builder-lib/out/toolsets/windows");

for (let attempt = 0; ; attempt += 1) {
  try {
    await getMakeNsisPath(undefined);
    console.log("NSIS test compiler ready");
    break;
  } catch (error) {
    if (attempt >= RETRY_DELAYS_MS.length) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`NSIS test compiler preparation failed (${reason}); retrying in ${RETRY_DELAYS_MS[attempt] / 1_000} s.`);
    await delay(RETRY_DELAYS_MS[attempt]);
  }
}
