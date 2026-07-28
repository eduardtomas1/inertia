import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../../src/server/database";
import {
  expectNoViewportOverflow as expectPageNoViewportOverflow,
} from "./layout-assertions";

const execFileAsync = promisify(execFile);

export interface RuntimeTestSnapshot {
  phase: string;
  generation: number;
  pid: number | null;
  websocketUrl: string | null;
}

export interface AppFixture {
  electronApp: ElectronApplication;
  page: Page;
  testDirectory: string;
  workspaceDirectory: string;
  secondWorkspaceDirectory: string | null;
  attachmentImagePath: string;
  attachmentDocumentPath: string;
  malformedAttachmentPath: string;
  rendererErrors: string[];
  previewUrl: string;
  runtimeSnapshot: () => Promise<RuntimeTestSnapshot>;
  resizeWindow: (width: number, height: number) => Promise<void>;
  expectNoViewportOverflow: () => Promise<void>;
  close: () => Promise<void>;
}

interface AppFixtureOptions {
  name: string;
  initialState: "empty" | "conversation";
  seedAssistantCodeBlock?: boolean;
  seedSecondProject?: boolean;
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createPreviewServer(): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((request, response) => {
    if (
      request.method === "POST"
      && request.url === "/backend-probe/v1/messages"
    ) {
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({
            type: "message_start",
            message: {
              type: "message",
              model: "visual-primary-model-with-a-deliberately-long-identifier",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          })}`,
          "",
          `data: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 1 },
          })}`,
          "",
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
        ].join("\n"));
      }, 450);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    response.end(
      "<!doctype html><title>Inertia preview</title>"
      + "<style>body{font-family:sans-serif;padding:40px}</style>"
      + "<h1>Preview is ready</h1>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Preview test server did not start");
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function createWorkspace(testDirectory: string): Promise<{
  workspaceDirectory: string;
  attachmentImagePath: string;
  attachmentDocumentPath: string;
  malformedAttachmentPath: string;
}> {
  const workspaceDirectory = join(testDirectory, "Inertia");
  await mkdir(workspaceDirectory, { recursive: true });
  const attachmentImagePath = join(testDirectory, "preview.png");
  const attachmentDocumentPath = join(testDirectory, "notes.pdf");
  const malformedAttachmentPath = join(testDirectory, "malformed.png");
  await writeFile(
    attachmentImagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    attachmentDocumentPath,
    Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii"),
  );
  await writeFile(
    malformedAttachmentPath,
    Buffer.from("%PDF-1.7\n%%EOF\n", "ascii"),
  );
  await Promise.all([
    mkdir(join(workspaceDirectory, "docs")),
    mkdir(join(workspaceDirectory, "empty-folder")),
    mkdir(join(workspaceDirectory, "src", "components", "deep"), {
      recursive: true,
    }),
  ]);
  await writeFile(
    join(workspaceDirectory, "sample.ts"),
    "export const version = '0.0.1';\n",
    "utf8",
  );
  await Promise.all([
    writeFile(
      join(workspaceDirectory, "docs", "guide.md"),
      "# Guide\n",
      "utf8",
    ),
    writeFile(
      join(workspaceDirectory, "src", "index.ts"),
      "export * from './components/Button';\n",
      "utf8",
    ),
    writeFile(
      join(workspaceDirectory, "src", "components", "Button.tsx"),
      "export const Button = () => <button>Ready</button>;\n",
      "utf8",
    ),
    writeFile(
      join(workspaceDirectory, "context.txt"),
      "ALPHA_CONTEXT\n",
      "utf8",
    ),
    writeFile(
      join(
        workspaceDirectory,
        "src",
        "components",
        "deep",
        "CaseSensitiveLeaf.ts",
      ),
      "export const leaf = true;\n",
      "utf8",
    ),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "."], { cwd: workspaceDirectory });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Inertia",
      "-c",
      "user.email=test@inertia.local",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: workspaceDirectory },
  );
  await writeFile(
    join(workspaceDirectory, "sample.ts"),
    "export const version = '0.0.1';\nexport const ready = true;\n",
    "utf8",
  );
  return {
    workspaceDirectory,
    attachmentImagePath,
    attachmentDocumentPath,
    malformedAttachmentPath,
  };
}

async function createSecondWorkspace(
  testDirectory: string,
): Promise<string> {
  const workspaceDirectory = join(testDirectory, "Companion");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(workspaceDirectory, "beta-only.ts"),
    "export const project = 'BETA_BASE';\n",
    "utf8",
  );
  await writeFile(
    join(workspaceDirectory, "context.txt"),
    "BETA_CONTEXT\n",
    "utf8",
  );
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["add", "."], { cwd: workspaceDirectory });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Inertia",
      "-c",
      "user.email=test@inertia.local",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: workspaceDirectory },
  );
  await writeFile(
    join(workspaceDirectory, "beta-only.ts"),
    [
      "export const project = 'BETA_BASE';",
      "export const marker = 'BETA_CHANGE';",
      "",
    ].join("\n"),
    "utf8",
  );
  return workspaceDirectory;
}

function seedConversation(
  testDirectory: string,
  workspaceDirectory: string,
  name: string,
  seedAssistantCodeBlock: boolean,
  secondWorkspaceDirectory: string | null,
): void {
  const store = new RuntimeStore(
    join(testDirectory, "data", "inertia.sqlite"),
    workspaceDirectory,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Inertia", workspaceDirectory);
  const conversation = store.createConversation(project.id, `${name} fixture`);
  if (secondWorkspaceDirectory) {
    const secondProject = store.createProject(
      "Companion",
      secondWorkspaceDirectory,
    );
    store.createConversation(
      secondProject.id,
      `${name} companion`,
    );
    store.selectConversation(conversation.id);
  }
  if (seedAssistantCodeBlock) {
    store.createMessage(
      conversation.id,
      [
        "# Settings fixture",
        "",
        "```ts file=src/settings.ts",
        "const ready: boolean = true;",
        "```",
      ].join("\n"),
      "assistant",
    );
  }
  store.close();
}

export async function createAppFixture(
  options: AppFixtureOptions,
): Promise<AppFixture> {
  const preview = await createPreviewServer();
  const testDirectory = await mkdtemp(
    join(tmpdir(), `inertia-${options.name}-`),
  );
  const workspace = await createWorkspace(testDirectory);
  const secondWorkspaceDirectory = options.seedSecondProject
    ? await createSecondWorkspace(testDirectory)
    : null;
  if (options.initialState === "conversation") {
    await mkdir(join(testDirectory, "data"), { recursive: true });
    seedConversation(
      testDirectory,
      workspace.workspaceDirectory,
      options.name,
      options.seedAssistantCodeBlock ?? false,
      secondWorkspaceDirectory,
    );
  }
  const rendererErrors: string[] = [];
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${join(testDirectory, "electron-profile")}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: join(testDirectory, "data"),
      INERTIA_WORKSPACE_DIR: workspace.workspaceDirectory,
    },
  });
  const page = await electronApp.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  if (options.initialState === "empty") {
    await page.getByRole("button", { name: "Add your first project" }).waitFor();
  } else {
    await page.getByRole("textbox", { name: "Message" }).waitFor();
  }

  const runtimeSnapshot = async (): Promise<RuntimeTestSnapshot> => {
    const snapshot = await electronApp.evaluate(() => {
      const runtime = Reflect.get(
        globalThis,
        "__inertiaTestRuntime",
      ) as { snapshot: () => RuntimeTestSnapshot } | undefined;
      return runtime?.snapshot() ?? null;
    });
    if (!snapshot) {
      throw new Error("The test runtime supervisor is unavailable");
    }
    return snapshot;
  };
  const resizeWindow = async (width: number, height: number): Promise<void> => {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setContentSize(size.width, size.height);
      },
      { width, height },
    );
    await page.waitForTimeout(250);
  };

  return {
    electronApp,
    page,
    testDirectory,
    ...workspace,
    secondWorkspaceDirectory,
    rendererErrors,
    previewUrl: preview.url,
    runtimeSnapshot,
    resizeWindow,
    expectNoViewportOverflow: () => expectPageNoViewportOverflow(page),
    close: async () => {
      preview.server.closeAllConnections();
      await new Promise<void>((resolve) => preview.server.close(() => resolve()));
      const runtimePid = (await runtimeSnapshot().catch(() => null))?.pid ?? null;
      await electronApp.evaluate(() => {
        const runtime = Reflect.get(
          globalThis,
          "__inertiaTestRuntime",
        ) as { quit?: () => unknown } | undefined;
        runtime?.quit?.();
      }).catch(() => undefined);
      await electronApp.close();
      if (runtimePid) {
        await expect.poll(
          () => processExists(runtimePid),
          { timeout: 5_000 },
        ).toBe(false);
      }
      // Windows can retain the closed SQLite handle for a brief interval after
      // the utility process exits. Use Node's bounded EBUSY/EPERM retry path
      // so successful scenarios are not reported as product failures.
      await rm(testDirectory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    },
  };
}
