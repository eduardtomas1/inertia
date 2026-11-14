import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_DELAYS_MS = Object.freeze([15_000, 45_000, 90_000]);

for (let attempt = 0; ; attempt += 1) {
  const result = spawnSync(process.execPath, ["-e", "console.log(require('electron'))"], {
    stdio: "inherit",
  });
  if (result.status === 0) break;
  if (attempt >= RETRY_DELAYS_MS.length) {
    process.exitCode = result.status ?? 1;
    break;
  }
  console.warn(`Electron binary preparation failed; retrying in ${RETRY_DELAYS_MS[attempt] / 1_000} s.`);
  await delay(RETRY_DELAYS_MS[attempt]);
}
