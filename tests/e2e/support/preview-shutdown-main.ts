import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, type Session, type WebContents } from "electron";
import { PreviewBroker } from "../../../src/main/preview-broker";

app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);
const deadline = setTimeout(() => { console.error("Preview shutdown deadline"); app.exit(91); }, 25_000);
deadline.unref();

async function run(): Promise<void> {
  await app.whenReady();
  let scenarios = 0;
  for (const action of ["close", "destroy"] as const) {
    for (const closeContentsFirst of [false, true]) {
      const window = new BrowserWindow({ show: false });
      await window.loadURL("about:blank");
      const tabs: WebContents[] = [];
      const unregistered = new Map<number, number>();
      const sessions = new Map<Session, number>();
      const clears: Promise<void>[] = [];
      const broker = new PreviewBroker({
        getWindow: () => window,
        openExternal: async () => undefined,
        stateChannel: "preview-shutdown-test",
        registerHealthRenderer: (contents) => {
          tabs.push(contents);
          const session = contents.session;
          if (!sessions.has(session)) {
            sessions.set(session, 0);
            const clearStorageData = session.clearStorageData.bind(session);
            session.clearStorageData = (...args) => {
              sessions.set(session, sessions.get(session)! + 1);
              const clear = clearStorageData(...args);
              clears.push(clear);
              return clear;
            };
          }
          return () => unregistered.set(contents.id, (unregistered.get(contents.id) ?? 0) + 1);
        },
      });
      for (const ownerId of ["primary", "secondary"] as const) {
        const owner = { ownerId, contextId: randomUUID(), connectionId: randomUUID() };
        broker.connect(owner);
        broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 400, height: 300 } });
        await broker.tab({ ...owner, action: "open" });
      }
      assert.equal(tabs.length, 4);
      const destroyed = tabs.map((contents) => new Promise<void>((resolve) => contents.once("destroyed", resolve)));
      const closed = new Promise<void>((resolve, reject) => window.once("closed", () => {
        try {
          assert(window.isDestroyed());
          assert.throws(() => window.contentView, /destroyed/u);
          if (closeContentsFirst) for (const contents of tabs) if (!contents.isDestroyed()) contents.close();
          broker.close();
          broker.close();
          resolve();
        } catch (error) { reject(error); }
      }));
      window[action]();
      await closed;
      await Promise.all([...destroyed, ...clears]);
      assert(tabs.every((contents) => contents.isDestroyed()));
      assert.equal(unregistered.size, 4);
      assert([...unregistered.values()].every((count) => count === 1));
      assert.equal(sessions.size, 2);
      assert([...sessions.values()].every((count) => count === 1));
      scenarios += 1;
    }
  }
  console.log(`PREVIEW_SHUTDOWN ${JSON.stringify({ scenarios, platform: process.platform, electron: process.versions.electron })}`);
}

void run().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1); });
