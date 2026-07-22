import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";

describe("provider runtime", () => {
  const roots: string[] = [];
  afterEach(async () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  function fakeCodex(): { root: string; command: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-"));
    roots.push(root);
    const command = join(root, "fake-codex");
    writeFileSync(command, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fake-codex 1.2.3'); process.exit(0); }
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'A calm result.'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`);
    chmodSync(command, 0o700);
    return { root, command };
  }

  it("detects, normalizes, and completes a streamed Codex-style session", async () => {
    const fake = fakeCodex();
    const manager = new ProviderManager({ commands: { codex: fake.command } });
    const detection = await manager.detect("codex", { cwd: fake.root });
    expect(detection).toMatchObject({ available: true, version: "1.2.3" });

    const text: string[] = [];
    const sessions: string[] = [];
    const result = await manager.run(
      { providerId: "codex", conversationId: "conversation", cwd: fake.root, prompt: "Do the work", interactionMode: "build", access: "supervised" },
      { onText: (event) => text.push(event.text), onSession: (event) => sessions.push(event.sessionId) },
    );
    expect(result).toMatchObject({ status: "completed", text: "A calm result.", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(text).toEqual(["A calm result."]);
    expect(sessions).toEqual(["11111111-1111-4111-8111-111111111111"]);
    await manager.disposeAll();
  });
});
