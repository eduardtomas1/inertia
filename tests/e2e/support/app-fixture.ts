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
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../../src/server/database";
import { portableNodeExecutable } from "../../helpers/portable-provider-fixture";
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
  nativePreviewIsVisible: (url: string) => Promise<boolean>;
  runtimeSnapshot: () => Promise<RuntimeTestSnapshot>;
  recycleRuntime: () => Promise<void>;
  resizeWindow: (width: number, height: number) => Promise<void>;
  expectNoViewportOverflow: () => Promise<void>;
  restart: () => Promise<{
    electronApp: ElectronApplication;
    page: Page;
  }>;
  close: () => Promise<void>;
}

interface AppFixtureOptions {
  name: string;
  initialState: "empty" | "conversation";
  windowDisplay?: "primary";
  initialNewThreadMode?: "local" | "worktree";
  seedAssistantCodeBlock?: boolean;
  seedSecondProject?: boolean;
  codexAppServerSource?: string;
  codexResumeSource?: string;
  claudeAuthSource?: string;
  githubCliSources?: {
    pr: string;
    api: string;
    excludedFiles?: string[];
  };
  beforeLaunch?: (fixture: {
    testDirectory: string;
    workspaceDirectory: string;
    secondWorkspaceDirectory: string | null;
  }) => void | Promise<void>;
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
    if (request.url === "/agent-browser-page") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(
        "<!doctype html><title>Agent browser source</title>"
        + "<style>body{font-family:sans-serif;padding:40px}</style>"
        + "<a href='/agent-browser-destination'>Continue in Browser</a>",
      );
      return;
    }
    if (request.url === "/agent-browser-privacy-start") {
      const secret = "document-start-password-sentinel";
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
      });
      response.end(
        "<!doctype html><html><head><title>Privacy preload probe</title>"
        + "<script>const input=document.createElement('input');"
        + "input.type='password';document.documentElement.append(input);"
        + `input.value=${JSON.stringify(secret)};input.type='text';input.remove();`
        + `document.title=${JSON.stringify(secret)}</script></head>`
        + `<body>${secret}</body></html>`,
      );
      return;
    }
    if (request.url === "/agent-browser-nested-privacy-start") {
      const secret = "nested-password-sentinel";
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'",
      });
      response.end(
        "<!doctype html><title>Nested privacy probe</title>"
        + "<div id='closed-host'></div>"
        + "<iframe title='Credential frame' src='/agent-browser-nested-privacy-frame'></iframe>"
        + "<script>const root=document.querySelector('#closed-host').attachShadow({mode:'closed'});"
        + "const input=document.createElement('input');input.type='password';"
        + `input.value=${JSON.stringify(secret)};root.append(input)</script>`,
      );
      return;
    }
    if (request.url === "/agent-browser-nested-privacy-frame") {
      const secret = "nested-password-sentinel";
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
      });
      response.end(
        "<!doctype html><title>Nested credential frame</title>"
        + "<input id='credential' type='password'>"
        + `<script>document.querySelector('#credential').value=${JSON.stringify(secret)}</script>`,
      );
      return;
    }
    if (request.url === "/agent-browser-frame-lifetime-privacy") {
      const secret = "removed-frame-password-sentinel";
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
      });
      response.end(
        "<!doctype html><title>Removed frame privacy probe</title><body></body>"
        + "<script>const frame=document.createElement('iframe');document.body.append(frame);"
        + "const input=frame.contentDocument.createElement('input');input.type='password';"
        + `input.value=${JSON.stringify(secret)};frame.contentDocument.body.append(input);`
        + "const mirror=document.createElement('p');mirror.textContent=input.value;"
        + "document.body.append(mirror);frame.remove()</script>",
      );
      return;
    }
    if (request.url === "/agent-browser-shadow-lifetime-privacy") {
      const secret = "removed-shadow-password-sentinel";
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
      });
      response.end(
        "<!doctype html><title>Removed shadow privacy probe</title><body></body>"
        + "<script>const host=document.createElement('div');document.body.append(host);"
        + "const root=host.attachShadow({mode:'closed'});const input=document.createElement('input');"
        + `input.type='password';input.value=${JSON.stringify(secret)};root.append(input);`
        + "const mirror=document.createElement('p');mirror.textContent=input.value;"
        + "document.body.append(mirror);host.remove()</script>",
      );
      return;
    }
    if (request.url === "/agent-browser-destination") {
      setTimeout(() => {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        response.end(
          "<!doctype html><title>Agent browser destination</title>"
          + "<style>body{font-family:sans-serif;padding:40px}</style>"
          + "<h1>Browser navigation settled</h1>"
          + "<form action='/agent-browser-key-destination'>"
          + "<label>Search destination <input name='query' aria-label='Search destination'></label>"
          + "</form>",
        );
      }, 450);
      return;
    }
    if (request.url?.startsWith("/agent-browser-key-destination")) {
      setTimeout(() => {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        });
        response.end(
          "<!doctype html><title>Agent browser key destination</title>"
          + "<h1>Keyboard navigation settled</h1>"
          + "<label>Type destination <input name='type-query' aria-label='Type destination'></label>"
          + "<script>document.querySelector('[name=type-query]').addEventListener('input',event=>{"
          + "location.href='/agent-browser-type-destination?query='"
          + "+encodeURIComponent(event.currentTarget.value)})</script>",
        );
      }, 450);
      return;
    }
    if (request.url?.startsWith("/agent-browser-type-destination")) {
      setTimeout(() => {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
        });
        response.end(
          "<!doctype html><title>Agent browser type destination</title>"
          + "<h1>Typing navigation settled</h1>"
          + "<label>Private upload <input type='file' aria-label='Private upload'></label>"
          + "<button type='button'>Choose through page handler</button>"
          + "<script>document.querySelector('button').addEventListener('click',()=>{"
          + "setTimeout(()=>{const input=document.querySelector('input[type=file]');"
          + "window.__delayedPickerInvoked=true;"
          + "try{if(typeof input.showPicker==='function')input.showPicker();else input.click()}"
          + "catch(error){window.__delayedPickerRejected=String(error)}"
          + "},600)})</script>",
        );
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

function readableAttachmentPdf(): Buffer {
  const stream = "BT /F1 12 Tf 72 720 Td (Inertia fixture PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
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
    readableAttachmentPdf(),
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
  let providerBinDirectory: string | null = null;
  const secondWorkspaceDirectory = options.seedSecondProject
    ? await createSecondWorkspace(testDirectory)
    : null;
  if (options.codexAppServerSource) {
    await Promise.all(
      [workspace.workspaceDirectory, secondWorkspaceDirectory]
        .filter((directory): directory is string => Boolean(directory))
        .flatMap((directory) => [
          writeFile(
            join(directory, "app-server"),
            options.codexAppServerSource!,
            "utf8",
          ),
          writeFile(
            join(directory, "login"),
            [
              'if (process.argv[2] === "status") {',
              '  process.stdout.write("Logged in using ChatGPT\\n");',
              "  process.exit(0);",
              "}",
              'process.stdout.write("Sign-in complete\\n");',
              "",
            ].join("\n"),
            "utf8",
          ),
          ...(options.codexResumeSource
            ? [writeFile(
                join(directory, "resume"),
                options.codexResumeSource,
                "utf8",
              )]
            : []),
          writeFile(
            join(directory, ".git", "info", "exclude"),
            `app-server\nlogin\n${options.codexResumeSource ? "resume\n" : ""}`,
            { encoding: "utf8", flag: "a" },
          ),
        ]),
    );
  }
  if (options.claudeAuthSource || options.githubCliSources) {
    providerBinDirectory = join(testDirectory, "provider-bin");
    await mkdir(providerBinDirectory, { recursive: true });
  }
  if (options.claudeAuthSource) {
    if (!providerBinDirectory) throw new Error("Provider fixture bin was not created.");
    portableNodeExecutable(providerBinDirectory, "claude");
    await Promise.all([
      writeFile(
        join(workspace.workspaceDirectory, "auth"),
        options.claudeAuthSource,
        "utf8",
      ),
      writeFile(
        join(workspace.workspaceDirectory, ".git", "info", "exclude"),
        "auth\n",
        { encoding: "utf8", flag: "a" },
      ),
    ]);
  }
  if (options.githubCliSources) {
    if (!providerBinDirectory) throw new Error("GitHub fixture bin was not created.");
    portableNodeExecutable(providerBinDirectory, "gh");
    await Promise.all([
      writeFile(
        join(workspace.workspaceDirectory, "pr"),
        options.githubCliSources.pr,
        "utf8",
      ),
      writeFile(
        join(workspace.workspaceDirectory, "api"),
        options.githubCliSources.api,
        "utf8",
      ),
      writeFile(
        join(workspace.workspaceDirectory, ".git", "info", "exclude"),
        [
          "pr",
          "api",
          ...(options.githubCliSources.excludedFiles ?? []),
          "",
        ].join("\n"),
        { encoding: "utf8", flag: "a" },
      ),
    ]);
  }
  if (options.initialState === "conversation") {
    await mkdir(join(testDirectory, "data"), { recursive: true });
    seedConversation(
      testDirectory,
      workspace.workspaceDirectory,
      options.name,
      options.seedAssistantCodeBlock ?? false,
      secondWorkspaceDirectory,
    );
  } else if (options.initialNewThreadMode) {
    await mkdir(join(testDirectory, "data"), { recursive: true });
    const store = new RuntimeStore(
      join(testDirectory, "data", "inertia.sqlite"),
      workspace.workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    store.updateSettings({
      newThreadMode: options.initialNewThreadMode,
    });
    store.close();
  }
  await options.beforeLaunch?.({
    testDirectory,
    workspaceDirectory: workspace.workspaceDirectory,
    secondWorkspaceDirectory,
  });
  const rendererErrors: string[] = [];
  const startupDiagnostics: string[] = [];
  const launchOptions = {
    args: [".", `--user-data-dir=${join(testDirectory, "electron-profile")}`],
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_DATA_DIR: join(testDirectory, "data"),
      INERTIA_WORKSPACE_DIR: workspace.workspaceDirectory,
      ...(providerBinDirectory
        ? {
            PATH: [providerBinDirectory, process.env.PATH ?? ""]
              .filter(Boolean)
              .join(delimiter),
          }
        : {}),
      ...(options.codexAppServerSource
        ? { INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: process.execPath }
        : {}),
    },
  };
  const appendDiagnostic = (source: string, chunk: Buffer | string): void => {
    startupDiagnostics.push(`${source}: ${String(chunk)}`.slice(0, 16_384));
    if (startupDiagnostics.length > 40) startupDiagnostics.shift();
  };
  const observeApp = (current: ElectronApplication, currentPage: Page): void => {
    current.process().stdout?.on("data", (chunk: Buffer) => {
      appendDiagnostic("stdout", chunk);
    });
    current.process().stderr?.on("data", (chunk: Buffer) => {
      appendDiagnostic("stderr", chunk);
    });
    currentPage.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    currentPage.on("pageerror", (error) => rendererErrors.push(error.message));
  };
  let electronApp: ElectronApplication | null = null;
  let page: Page;
  try {
    electronApp = await electron.launch(launchOptions);
    page = await electronApp.firstWindow();
    observeApp(electronApp, page);
    if (options.windowDisplay === "primary") {
      await electronApp.evaluate(
        ({ BrowserWindow, screen }) => {
          const origin = screen.getPrimaryDisplay().workArea;
          BrowserWindow.getAllWindows()[0]?.setPosition(origin.x, origin.y);
        },
      );
    }
    await page.locator(
      '.app-shell[data-connection-status="online"]',
    ).waitFor();
    if (options.initialState === "empty") {
      await page.getByRole("button", { name: "Add your first project" }).waitFor();
    } else {
      await page.getByRole("textbox", { name: "Message" }).waitFor();
    }
  } catch (cause) {
    preview.server.closeAllConnections();
    await new Promise<void>((resolve) => preview.server.close(() => resolve()));
    await electronApp?.close().catch(() => undefined);
    await rm(testDirectory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
    const diagnostics = [...startupDiagnostics, ...rendererErrors]
      .join("\n")
      .trim();
    throw new Error(
      `Electron fixture did not reach its ready state${
        diagnostics ? `:\n${diagnostics}` : "."
      }`,
      { cause },
    );
  }

  const currentApp = (): ElectronApplication => {
    if (!electronApp) throw new Error("The Electron fixture is unavailable");
    return electronApp;
  };
  const runtimeSnapshot = async (): Promise<RuntimeTestSnapshot> => {
    const snapshot = await currentApp().evaluate(() => {
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
  const recycleRuntime = async (): Promise<void> => {
    const confirmed = await currentApp().evaluate(async () => {
      const runtime = Reflect.get(
        globalThis,
        "__inertiaTestRuntime",
      ) as { recycle?: () => Promise<boolean> } | undefined;
      return await runtime?.recycle?.() ?? false;
    });
    if (!confirmed) throw new Error("The test runtime did not recycle cleanly.");
  };
  const resizeWindow = async (width: number, height: number): Promise<void> => {
    await currentApp().evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setContentSize(size.width, size.height);
      },
      { width, height },
    );
    await page.waitForTimeout(250);
  };
  const nativePreviewIsVisible = async (url: string): Promise<boolean> =>
    await currentApp().evaluate(
      ({ BrowserWindow }, previewUrl) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return false;
        const preview = window.contentView.children.find((view) => {
          const contents = Reflect.get(view, "webContents") as
            | { getURL: () => string }
            | undefined;
          return contents?.getURL() === previewUrl;
        });
        if (!preview) return false;
        const bounds = preview.getBounds();
        return bounds.width > 0 && bounds.height > 0;
      },
      url,
    );

  return {
    get electronApp() {
      return currentApp();
    },
    get page() {
      return page;
    },
    testDirectory,
    ...workspace,
    secondWorkspaceDirectory,
    rendererErrors,
    previewUrl: preview.url,
    nativePreviewIsVisible,
    runtimeSnapshot,
    recycleRuntime,
    resizeWindow,
    expectNoViewportOverflow: () => expectPageNoViewportOverflow(page),
    restart: async () => {
      const previousApp = electronApp;
      if (!previousApp) throw new Error("The Electron fixture is unavailable");
      const runtimePid = (await runtimeSnapshot().catch(() => null))?.pid
        ?? null;
      await previousApp.evaluate(() => {
        const runtime = Reflect.get(
          globalThis,
          "__inertiaTestRuntime",
        ) as { quit?: () => unknown } | undefined;
        runtime?.quit?.();
      }).catch(() => undefined);
      await previousApp.close();
      if (runtimePid) {
        await expect.poll(
          () => processExists(runtimePid),
          { timeout: 5_000 },
        ).toBe(false);
      }

      const nextApp = await electron.launch(launchOptions);
      electronApp = nextApp;
      const nextPage = await nextApp.firstWindow();
      page = nextPage;
      observeApp(nextApp, nextPage);
      if (options.windowDisplay === "primary") {
        await nextApp.evaluate(
          ({ BrowserWindow, screen }) => {
            const origin = screen.getPrimaryDisplay().workArea;
            BrowserWindow.getAllWindows()[0]?.setPosition(origin.x, origin.y);
          },
        );
      }
      await nextPage.locator(
        '.app-shell[data-connection-status="online"]',
      ).waitFor();
      await nextPage.getByRole("textbox", { name: "Message" }).waitFor();
      return { electronApp: nextApp, page: nextPage };
    },
    close: async () => {
      preview.server.closeAllConnections();
      await new Promise<void>((resolve) => preview.server.close(() => resolve()));
      const runtimePid = (await runtimeSnapshot().catch(() => null))?.pid ?? null;
      const activeApp = currentApp();
      await activeApp.evaluate(() => {
        const runtime = Reflect.get(
          globalThis,
          "__inertiaTestRuntime",
        ) as { quit?: () => unknown } | undefined;
        runtime?.quit?.();
      }).catch(() => undefined);
      await activeApp.close();
      if (runtimePid) {
        await expect.poll(
          () => processExists(runtimePid),
          { timeout: 5_000 },
        ).toBe(false);
      }
      // Closed SQLite handles on Windows and recently-settled Git checkpoint
      // writes on macOS can remain visible for a brief interval after their
      // owning process exits. Node's recursive removal retries the bounded set
      // of transient EBUSY/ENOTEMPTY/EPERM failures without hiding a persistent
      // cleanup problem.
      await rm(testDirectory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    },
  };
}
