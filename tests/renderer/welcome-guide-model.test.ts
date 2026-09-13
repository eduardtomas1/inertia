import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  clampWelcomeStep,
  PROVIDER_READINESS_LABELS,
  providerReadiness,
  topicDetail,
  WELCOME_STEPS,
  WELCOME_TILES,
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
  it("keeps four steps with next-step labels, six demo topics and three demo tiles", () => {
    expect(WELCOME_STEPS.map(({ primary }) => primary)).toEqual([
      "Take the tour",
      "Connect an agent",
      "Continue",
      "Start using Inertia",
    ]);
    expect(WELCOME_TOPICS.map(({ id }) => id)).toEqual(["split", "work", "duo", "ship", "limits", "keys"]);
    expect(WELCOME_TILES.map(({ demo }) => demo)).toEqual(["work", "split", "ship"]);
    const keys = WELCOME_TOPICS.find(({ id }) => id === "keys")!;
    expect(topicDetail(keys.detail, [
      { keys: "Ctrl+K", label: "Search" },
      { keys: "Ctrl+N", label: "New chat" },
    ])).toBe("Press Ctrl+K to search everything and Ctrl+N for a new chat.");
    expect(topicDetail(keys.detail, [])).toBe("Press ⌘K to search everything and ⌘N for a new chat.");
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
    expect(reduced).toContain(".welcome-demo *");
    expect(reduced).toContain(".welcome-demo *::after");
    expect(reduced).toContain(".welcome-guide-step");
    expect(reduced).toContain("animation: none !important");
    expect(css).toContain(
      '.app-shell[data-document-visible="false"] .welcome-demo *',
    );
    const keyframes = [...css.matchAll(/@keyframes d-[\w-]+ \{\n([\s\S]*?)\n\}/gu)].map((match) => match[1]!);
    expect(keyframes.length).toBeGreaterThan(30);
    expect(css).not.toContain("infinite");
    expect(css).not.toContain("d-clock");
    expect(css).not.toContain("welcome-copy-in");
    expect(css).toContain("from { opacity: 0.35; transform: translateX(");
    expect(css).toContain("animation: welcome-step-out 180ms ease-in both;");
    expect(css).toContain(".welcome-guide-step.is-leaving {\n    display: none;");
    expect(css).toContain("animation: d-enter 200ms ease-out 40ms both;");
    expect(css).toContain("animation: d-leave 120ms ease-in both;");
    expect(new Set(keyframes.flatMap((body) => [...body.matchAll(/([a-z-]+):/gu)].map((match) => match[1]))))
      .toEqual(new Set(["animation-timing-function", "clip-path", "opacity", "transform"]));
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain("height: min(500px, calc(100vh - 32px))");
  });
});
