// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

// Exercises the real guarded gh process, IPC, confirmation, durable pending receipt
// and restart. The fixture never contacts GitHub or uses a real credential.
test("links across repositories and resolves one native stack merge after restart", async () => {
  let statePath = "";
  const app = await createAppFixture({ name: "pr-stacks", initialState: "conversation", workspaceGit: false,
    beforeLaunch: ({ testDirectory }) => {
      statePath = join(testDirectory, "github-state.json");
      writeFileSync(statePath, JSON.stringify({ mutations: 0, merged: false }));
      writeNodeFlagExecutable(join(testDirectory, "provider-bin"), "gh", `
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const sha = value => value.toString(16).padStart(40, "0");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const body = input ? JSON.parse(input) : {};
  let result;
  if (args.includes("graphql")) {
    const { owner, name, number } = body.variables;
    result = { data: { repository: { pullRequest: {
      id: "PR_" + number, number, title: number === 41 ? "Add workspace navigation" : "Keep related pull requests together",
      state: state.merged ? "MERGED" : "OPEN", isDraft: false,
      headRefName: "feature-" + number, headRefOid: sha(number), baseRefName: number === 41 ? "main" : "feature-41", baseRefOid: sha(number - 1),
      additions: 30, deletions: 2, updatedAt: "2026-10-01T12:00:00Z", author: { login: "fixture" },
      mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", maintainerCanModify: false,
      headRepository: { viewerPermission: "WRITE" }, repository: { nameWithOwner: owner + "/" + name, viewerPermission: "WRITE" },
      commits: { nodes: [{ commit: { oid: sha(number), statusCheckRollup: null } }] },
      reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
    } } } };
  } else {
    const endpoint = args.find(value => value.startsWith("repos/"));
    if (endpoint.includes("/stacks")) {
      const stack = { id: "stack-one", number: 43, base: "main",
        pull_requests: [41, 42].map(number => ({ number, head: { ref: "feature-" + number, ...(endpoint.endsWith("/43") ? { sha: sha(number) } : {}) }, state: state.merged ? "closed" : "open", merged_at: state.merged ? "2026-10-01T12:00:00Z" : null, draft: false })) };
      result = endpoint.includes("/docs/") ? [] : endpoint.endsWith("/43") ? stack : [stack];
    }
    else if (args.includes("PUT")) {
      if (body.sha !== sha(42) || body.merge_action !== "default") process.exit(1);
      state.mutations++; result = { status: "pending", details: { uuid: "fixture-merge" } };
    } else if (endpoint.endsWith("/fixture-merge")) {
      state.merged = true; result = { status: "merged", details: { uuid: "fixture-merge" } };
    } else process.exit(1);
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify(result));
});`);
    },
  });
  let page = app.page;
  try {
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Pull requests");
    await page.getByRole("button", { name: "Link pull request", exact: true }).click();
    await page.getByRole("textbox", { name: "GitHub pull request URL" }).fill("https://github.com/acme/workspace/pull/42");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("button", { name: /Add workspace navigation/u })).toBeVisible();
    await page.getByRole("button", { name: "Link pull request", exact: true }).click();
    await page.getByRole("textbox", { name: "GitHub pull request URL" }).fill("https://github.com/acme/docs/pull/18");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Linked 3" })).toBeVisible();
    await page.getByRole("button", { name: /Keep related pull requests together.*acme\/workspace/u }).click();
    await page.getByRole("button", { name: "Stack #43 · layer 2 of 2" }).click();
    await page.getByRole("menuitem", { name: "Merge 2 layers…" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge stack #43" });
    await expect(dialog).toBeVisible();
    expect(JSON.parse(await readFile(statePath, "utf8")).mutations).toBe(0);
    await dialog.getByRole("button", { name: "Merge 2 layers" }).click();
    await expect(page.getByText("GitHub is merging the stack. Refresh to check its outcome.")).toBeVisible();
    expect(JSON.parse(await readFile(statePath, "utf8")).mutations).toBe(1);
    ({ page } = await app.restart());
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Pull requests");
    await page.getByRole("button", { name: "Refresh linked pull requests" }).click();
    await expect(page.getByText("GitHub merged the reviewed stack layers.")).toBeVisible();
    ({ page } = await app.restart());
    expect(JSON.parse(await readFile(statePath, "utf8")).mutations).toBe(1);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await test.info().attach("runtime-state", { body: JSON.stringify(await app.runtimeSnapshot(), null, 2), contentType: "application/json" });
    throw error;
  } finally { await app.close(); }
});
