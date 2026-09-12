// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { readBenchmarkComposerAdmission } from "./desktop-benchmark-readiness-diagnostic";

describe("benchmark composer evidence", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("observes route repair and admission flags without returning prompt or banner text", () => {
    document.body.innerHTML = `<div class="app-shell" data-connection-status="online">
      <section aria-label="Message composer" aria-busy="false" data-disabled="false">
        <textarea aria-label="Message">private prompt and credential</textarea>
        <div class="provider-readiness" data-transient="false" data-route-repair="connect">
          <span class="route-readiness-badge">Sign in</span><strong>private provider name</strong>
        </div>
        <button data-composer-action-state="send-disabled" aria-busy="false" disabled></button>
      </section></div>`;
    const value = readBenchmarkComposerAdmission();
    expect(value).toEqual({ connection: "online", composerPresent: true, promptPresent: true,
      inputDisabled: false, composerDisabled: false, composerBusy: false,
      sendDisabled: true, sendBusy: false, action: "send-disabled",
      routeBlocked: true, routeTransient: false, routeBadge: "Sign in", routeRepair: "connect" });
    expect(JSON.stringify(value)).not.toMatch(/private|credential/u);
  });

  it("keeps missing observations unknown and rejects arbitrary DOM attributes before crossing IPC", () => {
    expect(readBenchmarkComposerAdmission()).toMatchObject({ composerPresent: false,
      promptPresent: null, routeBlocked: null, sendDisabled: null, action: null });
    document.body.innerHTML = `<div class="app-shell" data-connection-status="secret">
      <section aria-label="Message composer" aria-busy="secret" data-disabled="secret">
        <textarea aria-label="Message" disabled> </textarea>
        <div class="provider-readiness" data-transient="secret" data-route-repair="secret">
          <span class="route-readiness-badge">secret</span>
        </div>
        <button data-composer-action-state="secret" aria-busy="secret"></button>
      </section></div>`;
    const value = readBenchmarkComposerAdmission();
    expect(value).toMatchObject({ connection: null, promptPresent: false, inputDisabled: true,
      composerDisabled: null, composerBusy: null, sendBusy: null, action: null,
      routeTransient: null, routeBadge: null, routeRepair: null });
    expect(JSON.stringify(value)).not.toContain("secret");
  });
});
