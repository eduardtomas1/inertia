// @inertia-e2e-resource primary-display
import { test } from "@playwright/test";

import { checkNativeBrowserEvidence } from "./support/native-browser-evidence";

test("Linux Browser captures and recovers without visibility emulation", async () => {
  test.skip(process.platform !== "linux", "Native reproduction of the Linux failure reported in #382");
  await checkNativeBrowserEvidence();
});
