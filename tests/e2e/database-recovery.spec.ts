import { expect, test } from "@playwright/test";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture } from "./support/app-fixture";

test("reports and preserves an incomplete SQLite family on startup", async ({
  browserName: _browserName,
}, testInfo) => {
  const app = await createAppFixture({
    name: "orphan-database-family-recovery",
    initialState: "empty",
    beforeLaunch: async ({ testDirectory }) => {
      const dataDirectory = join(testDirectory, "data");
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(
          join(dataDirectory, "inertia.sqlite-wal"),
          "orphaned wal evidence",
          { mode: 0o600 },
        ),
        writeFile(
          join(dataDirectory, "inertia.sqlite-shm"),
          "orphaned shm evidence",
          { mode: 0o600 },
        ),
      ]);
    },
  });
  try {
    const notice = app.page.getByRole("alert", {
      name: "Database recovery warning",
    });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Inertia started with empty data");
    await expect(notice).toContainText(
      "Incomplete database files were preserved for recovery.",
    );
    const screenshot = testInfo.outputPath(
      "orphan-database-family-recovery.png",
    );
    await app.page.screenshot({
      animations: "disabled",
      path: screenshot,
    });
    await testInfo.attach("orphan database family recovery", {
      path: screenshot,
      contentType: "image/png",
    });

    const dataDirectory = join(app.testDirectory, "data");
    const evidenceDirectory = join(dataDirectory, "corrupt");
    const evidence = (await readdir(evidenceDirectory)).sort();
    expect(evidence).toHaveLength(2);
    expect(await readFile(join(
      evidenceDirectory,
      evidence.find((name) => name.endsWith(".sqlite-wal"))!,
    ), "utf8")).toBe("orphaned wal evidence");
    expect(await readFile(join(
      evidenceDirectory,
      evidence.find((name) => name.endsWith(".sqlite-shm"))!,
    ), "utf8")).toBe("orphaned shm evidence");
    expect(JSON.parse(await readFile(join(
      dataDirectory,
      "recovery",
      "last-database-recovery.json",
    ), "utf8"))).toMatchObject({
      outcome: "created-empty",
      trigger: "primary-missing",
      preservedDatabaseFamilyMembers: 2,
    });
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
