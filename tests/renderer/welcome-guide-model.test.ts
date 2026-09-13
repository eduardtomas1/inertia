import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  clampWelcomeStep,
  PROVIDER_READINESS_LABELS,
  providerReadiness,
  WELCOME_STEPS,
  WELCOME_TOPICS,
} from "../../src/renderer/src/components/welcome-guide/welcomeGuideModel";
import {
  closeWelcomeGuide,
  markWelcomeGuideSeen,
  openWelcomeGuide,
  readWelcomeGuideSeen,
  subscribeWelcomeGuide,
  WELCOME_GUIDE_STORAGE_KEY,
  welcomeGuideGate,
  welcomeGuideIsOpen,
} from "../../src/renderer/src/utils/welcomeGuide";

describe("welcome guide gate", () => {
  it("opens only for a fresh profile without projects", () => {
    const fresh = { seen: false, projectCount: 0, blocked: false, existingProfile: false };
    expect(welcomeGuideGate(fresh)).toBe("open");
    expect(welcomeGuideGate({ ...fresh, projectCount: null })).toBe("wait");
    expect(welcomeGuideGate({ ...fresh, blocked: true })).toBe("wait");
    expect(welcomeGuideGate({ ...fresh, seen: true })).toBe("wait");
    expect(welcomeGuideGate({ ...fresh, projectCount: 2 })).toBe("mark-seen");
    expect(welcomeGuideGate({ ...fresh, existingProfile: true })).toBe("mark-seen");
  });

  it("remembers that the guide was seen and fails closed on storage errors", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    };
    expect(readWelcomeGuideSeen(storage)).toBe(false);
    markWelcomeGuideSeen(storage);
    expect(stored.has(WELCOME_GUIDE_STORAGE_KEY)).toBe(true);
    expect(readWelcomeGuideSeen(storage)).toBe(true);

    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readWelcomeGuideSeen(broken)).toBe(true);
    expect(() => markWelcomeGuideSeen(broken)).not.toThrow();
  });

  it("notifies subscribers once per open or close", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWelcomeGuide(listener);
    openWelcomeGuide();
    openWelcomeGuide();
    expect(welcomeGuideIsOpen()).toBe(true);
    closeWelcomeGuide();
    closeWelcomeGuide();
    expect(welcomeGuideIsOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("welcome guide model", () => {
  it("keeps four steps with next-step labels and five tour topics", () => {
    expect(WELCOME_STEPS.map(({ primary }) => primary)).toEqual([
      "Take the tour",
      "Connect an agent",
      "Continue",
      "Start using Inertia",
    ]);
    expect(WELCOME_TOPICS.map(({ id }) => id)).toEqual(["chat", "split", "duo", "review", "limits"]);
    expect(clampWelcomeStep(-1)).toBe(0);
    expect(clampWelcomeStep(9)).toBe(3);
  });

  it("describes provider readiness from install and sign-in state", () => {
    const ready = { canRun: true, installState: "installed", authState: "authenticated" } as const;
    expect(providerReadiness(ready)).toBe("ready");
    expect(providerReadiness({ ...ready, canRun: false, installState: "checking" })).toBe("checking");
    expect(providerReadiness({ ...ready, canRun: false, installState: "not-installed" })).toBe("install");
    expect(providerReadiness({ ...ready, canRun: false, authState: "unauthenticated" })).toBe("sign-in");
    expect(providerReadiness({ ...ready, canRun: false, authState: "error" })).toBe("attention");
    expect(PROVIDER_READINESS_LABELS["sign-in"]).toBe("Sign in needed");
  });

  it("keeps motion decorative, reduced-motion safe and paused while hidden", async () => {
    const css = await readFile(
      new URL(
        "../../src/renderer/src/components/welcome-guide/WelcomeGuide.css",
        import.meta.url,
      ),
      "utf8",
    );
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".welcome-vignette *");
    expect(reduced).toContain(".welcome-guide-step");
    expect(reduced).toContain("animation: none !important");
    expect(css).toContain(
      '.app-shell[data-document-visible="false"] .welcome-vignette *',
    );
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain("height: min(500px, calc(100vh - 32px))");
  });
});
