// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const exec = promisify(execFile);
test("Git badges reflect real status and colored editing preserves text, scrolling, undo and guarded saves", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "file-git-editor", initialState: "conversation",
    beforeLaunch: async ({ workspaceDirectory }) => {
      await writeFile(join(workspaceDirectory, "Added.java"), [
        "package example;", "", "import java.util.List;", "",
        "/** A synthetic example for editor verification. */", "public final class Added {",
        '    private static final String READY = "ready";', "",
        "    public String describe(List<String> items) {",
        "        if (items.isEmpty()) {", '            return "Nothing to process";', "        }", "",
        "        // Keep native editing, selection and undo intact.",
        '        return READY + ": " + String.join(", ", items);', "    }", "}", "",
      ].join("\n"));
      await exec("git", ["add", "--", "Added.java"], { cwd: workspaceDirectory });
      await writeFile(join(workspaceDirectory, "untracked.txt"), "Fixture only\n");
    },
  });
  try {
    const page = app.page;
    await app.resizeWindow(1440, 920);
    const tools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(tools, "Files");
    const panel = page.getByRole("region", { name: "Project files" });
    await expect(panel.getByRole("treeitem", { name: "sample.ts", exact: true })).toHaveAccessibleDescription(/Git: Modified/u);
    const added = panel.getByRole("treeitem", { name: "Added.java", exact: true });
    await expect(added).toHaveAccessibleDescription("Git: Added · staged");
    await expect(panel.getByRole("treeitem", { name: "untracked.txt", exact: true })).toHaveAccessibleDescription("Git: Untracked");
    await added.focus(); await added.press("Enter");
    await panel.getByRole("button", { name: "Edit Added.java", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit contents of Added.java" });
    await expect(page.locator(".syntax-textarea-mirror .hljs-keyword").first()).toBeVisible();
    const lightEditor = testInfo.outputPath("file-editor-light.png");
    await page.screenshot({ path: lightEditor });
    await testInfo.attach("file-editor-light", { path: lightEditor, contentType: "image/png" });
    const original = await editor.inputValue();
    await editor.press("ControlOrMeta+End");
    // Insert one native editing transaction; grouping individual key presses is
    // platform-dependent, so one undo need not remove an entire typed sentence.
    await page.keyboard.insertText("// verified");
    await editor.press("ControlOrMeta+z");
    await expect(editor).toHaveValue(original);
    const edited = `${original}${Array.from({ length: 100 }, (_, i) => `// line ${i}\t${"text ".repeat(35)}`).join("\n")}\n`;
    await editor.fill(edited);
    await expect(page.locator(".syntax-textarea")).toHaveClass(/is-highlighted/u);
    await editor.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = 300; element.scrollLeft = 90; element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(async () => page.locator(".syntax-textarea").evaluate((element) => {
      const text = element.querySelector("textarea")!; const mirror = element.querySelector("pre")!;
      const a = getComputedStyle(text); const b = getComputedStyle(mirror);
      return Math.abs(text.scrollTop - mirror.scrollTop) < 1 && Math.abs(text.scrollLeft - mirror.scrollLeft) < 1
        && text.clientWidth === mirror.clientWidth && a.fontSize === b.fontSize && a.lineHeight === b.lineHeight;
    })).toBe(true);
    await app.expectNoViewportOverflow();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await readFile(join(app.workspaceDirectory, "Added.java"), "utf8")).toBe(edited);
    await expect(added).toHaveAccessibleDescription("Git: Added · staged and unstaged");
    const path = testInfo.outputPath("file-git-badges.png");
    await page.screenshot({ path }); await testInfo.attach("file-git-badges", { path, contentType: "image/png" });
    // A new authoritative scan removes a badge after an external restore.
    const committed = await exec("git", ["show", "HEAD:sample.ts"], { cwd: app.workspaceDirectory });
    await writeFile(join(app.workspaceDirectory, "sample.ts"), committed.stdout);
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(panel.getByRole("treeitem", { name: "sample.ts", exact: true })).not.toHaveAttribute("aria-description");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await page.getByRole("button", { name: /^file-git-editor fixture, Codex,/u }).click();
    const darkTools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(darkTools, "Files");
    await expect(added).toHaveAccessibleDescription("Git: Added · staged and unstaged");
    const darkTree = testInfo.outputPath("file-git-badges-dark.png");
    await page.screenshot({ path: darkTree });
    await testInfo.attach("file-git-badges-dark", { path: darkTree, contentType: "image/png" });
    await panel.getByRole("button", { name: "Edit Added.java", exact: true }).click();
    await editor.fill(original);
    await expect(page.locator(".syntax-textarea-mirror .hljs-keyword").first()).toBeVisible();
    const darkEditor = testInfo.outputPath("file-editor-dark.png");
    await page.screenshot({ path: darkEditor });
    await testInfo.attach("file-editor-dark", { path: darkEditor, contentType: "image/png" });
    page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await readFile(join(app.workspaceDirectory, "Added.java"), "utf8")).toBe(edited);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
