// @inertia-e2e-resource primary-display
import { test } from "@playwright/test";
import { checkNativeCompletedHistory } from "./support/native-completed-history";

test("mounts completed history without entrance transitions in a natively hidden window", async ({ browserName: _browserName }, testInfo) => {
  const evidence = await checkNativeCompletedHistory();
  await testInfo.attach("native-completed-history", {
    body: Buffer.from(evidence), contentType: "text/plain",
  });
});
