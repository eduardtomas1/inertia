import { describe, expect, it } from "vitest";

import {
  createOrbLoop,
  ORB_CHANNEL_GRACE_MS,
  tunedOrbSize,
  type OrbConfig,
  type OrbLoopEnvironment,
} from "../../src/renderer/src/components/working-indicator/orbLoop";
import { ORB_MIN_DWELL_MS, ORB_CROSSFADE_MS } from "../../src/renderer/src/components/working-indicator/orbDwell";
import { MODE_FRAMES, resolvePreset } from "../../src/renderer/src/vendor/thinking-orbs";

function stillDots(design: "composing" | "connecting"): number {
  const { mode, opts } = resolvePreset(design, 20);
  return MODE_FRAMES[mode](20, 0.6, opts).dots.length;
}

interface FakeCanvas {
  width: number;
  height: number;
  style: { filter: string };
  dataset: Record<string, string>;
  getContext: (...args: unknown[]) => unknown;
  contextArguments: unknown[][];
  filters: string[];
  fills: string[];
  images: number;
  arcs: number;
}

function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    style: { filter: "" },
    dataset: {},
    contextArguments: [],
    filters: [],
    fills: [],
    images: 0,
    arcs: 0,
    getContext: (...args) => {
      canvas.contextArguments.push(args);
      return context;
    },
  };
  const context = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (property === "arc") return () => { canvas.arcs += 1; };
      if (property === "drawImage") return () => { canvas.images += 1; };
      if (property === "fillRect") return () => { canvas.fills.push("fillRect"); };
      return () => undefined;
    },
    set: (_target, property, value) => {
      if (property === "filter" && value !== "none") canvas.filters.push(value as string);
      return true;
    },
  });
  return canvas;
}

function fakeEnvironment() {
  let now = 1_000;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  const intersections = new Map<unknown, (visible: boolean) => void>();
  const state = { hidden: false, reduced: false, dark: true, accent: "#a3a3fa" };
  const glowLayers: FakeCanvas[] = [];
  const environment: OrbLoopEnvironment = {
    now: () => now,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => { frames.delete(handle); },
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimer: (handle) => { timers.delete(handle); },
    isDocumentHidden: () => state.hidden,
    prefersReducedMotion: () => state.reduced,
    forcedColors: () => false,
    isDarkTheme: () => state.dark,
    devicePixelRatio: () => 3,
    resolveColor: (_element, source) => (source === "accent" ? state.accent : "#ffffff"),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    observeIntersection: (element, listener) => {
      intersections.set(element, listener);
      return () => { intersections.delete(element); };
    },
    createGlowLayer: (width, height) => {
      const layer = fakeCanvas();
      layer.width = width;
      layer.height = height;
      glowLayers.push(layer);
      return { canvas: layer as never, context: layer.getContext() as never };
    },
  };
  const runFrames = (): number => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
    return pending.length;
  };
  return {
    environment,
    state,
    glowLayers,
    frames,
    timers,
    listeners,
    intersections,
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of Array.from(timers)) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    runFrames,
    emit() {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

const CONFIG: OrbConfig = {
  design: "connecting",
  pace: 1,
  speed: 1,
  color: "ink",
  customColor: "#ff5fd2",
  glow: false,
};

describe("shared orb animation loop", () => {
  it("runs one frame loop for every mounted orb and stops when none remain", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const first = fakeCanvas();
    const second = fakeCanvas();
    const a = loop.register(first as never, 18, CONFIG);
    const b = loop.register(second as never, 14, CONFIG);
    expect(first.width).toBe(Math.round(18 * 1.7 * 2));
    expect(second.height).toBe(Math.round(14 * 1.7 * 2));
    expect(first.contextArguments).toEqual([["2d"]]);
    expect(fake.frames.size).toBe(1);
    expect(fake.listeners.size).toBe(1);
    expect(fake.runFrames()).toBe(1);
    expect(fake.frames.size).toBe(1);
    a.dispose();
    expect(loop.stats()).toMatchObject({ mounted: 1, frameScheduled: true, subscribed: true });
    b.dispose();
    b.dispose();
    expect(loop.stats()).toMatchObject({ mounted: 0, frameScheduled: false, timerScheduled: false, subscribed: false });
    expect(fake.frames.size).toBe(0);
    expect(fake.listeners.size).toBe(0);
    expect(fake.intersections.size).toBe(0);
  });

  it("does not leak after many virtualised remounts", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    for (let index = 0; index < 200; index += 1) {
      const handle = loop.register(fakeCanvas() as never, 14, CONFIG, `conversation:${index % 5}`);
      fake.runFrames();
      handle.dispose();
    }
    expect(loop.stats()).toMatchObject({ mounted: 0, frameScheduled: false, subscribed: false });
    expect(loop.stats().channels).toBe(5);
    fake.advance(ORB_CHANNEL_GRACE_MS);
    expect(loop.stats().channels).toBe(0);
    expect(fake.timers.size).toBe(0);
  });

  it("pauses while the document is hidden and resumes when shown", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    loop.register(fakeCanvas() as never, 18, CONFIG);
    fake.state.hidden = true;
    fake.emit();
    expect(fake.frames.size).toBe(0);
    fake.state.hidden = false;
    fake.emit();
    expect(fake.frames.size).toBe(1);
  });

  it("pauses when no orb is inside the viewport", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const canvas = fakeCanvas();
    loop.register(canvas as never, 14, CONFIG);
    fake.intersections.get(canvas)?.(false);
    expect(loop.stats()).toMatchObject({ visible: 0, frameScheduled: false });
    const arcs = canvas.arcs;
    fake.runFrames();
    expect(canvas.arcs).toBe(arcs);
    fake.intersections.get(canvas)?.(true);
    expect(loop.stats().frameScheduled).toBe(true);
  });

  it("paints one still frame under reduced motion and reacts when it is toggled", () => {
    const fake = fakeEnvironment();
    fake.state.reduced = true;
    const loop = createOrbLoop(fake.environment);
    const canvas = fakeCanvas();
    loop.register(canvas as never, 18, CONFIG);
    const paintsAfterMount = loop.stats().paints;
    expect(paintsAfterMount).toBe(1);
    fake.runFrames();
    fake.runFrames();
    expect(fake.frames.size).toBe(0);
    expect(loop.stats().paints).toBe(paintsAfterMount);
    expect(loop.stats().timerScheduled).toBe(true);
    fake.state.reduced = false;
    fake.emit();
    expect(fake.frames.size).toBe(1);
    fake.runFrames();
    fake.advance(40);
    fake.runFrames();
    expect(loop.stats().paints).toBeGreaterThan(paintsAfterMount + 1);
  });

  it("switches designs after the dwell under reduced motion without a crossfade", () => {
    const fake = fakeEnvironment();
    fake.state.reduced = true;
    const loop = createOrbLoop(fake.environment);
    const canvas = fakeCanvas();
    const handle = loop.register(canvas as never, 18, CONFIG);
    handle.update({ ...CONFIG, design: "composing" });
    fake.runFrames();
    expect(canvas.dataset.orbShown).toBe("connecting");
    fake.advance(ORB_MIN_DWELL_MS);
    const before = canvas.arcs;
    fake.runFrames();
    expect(canvas.dataset.orbShown).toBe("composing");
    expect(canvas.arcs - before).toBe(stillDots("composing"));
  });

  it("crossfades without remounting when the design changes mid-turn", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const canvas = fakeCanvas();
    const handle = loop.register(canvas as never, 18, CONFIG);
    handle.update({ ...CONFIG, design: "solving" });
    fake.advance(ORB_MIN_DWELL_MS);
    fake.runFrames();
    expect(canvas.dataset.orbShown).toBe("solving");
    fake.advance(ORB_CROSSFADE_MS / 2);
    let before = canvas.arcs;
    fake.runFrames();
    const crossfading = canvas.arcs - before;
    fake.advance(ORB_CROSSFADE_MS);
    before = canvas.arcs;
    fake.runFrames();
    const settled = canvas.arcs - before;
    expect(settled).toBeGreaterThan(0);
    expect(crossfading).toBeGreaterThan(settled + 3);
    expect(loop.stats().mounted).toBe(1);
  });

  it("shares one dwell and clock between orbs of the same conversation", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const timeline = fakeCanvas();
    const sidebar = fakeCanvas();
    const a = loop.register(timeline as never, 18, CONFIG, "conversation:one");
    fake.advance(2_000);
    const b = loop.register(sidebar as never, 14, CONFIG, "conversation:one");
    a.update({ ...CONFIG, design: "composing" });
    b.update({ ...CONFIG, design: "composing" });
    fake.advance(100);
    fake.runFrames();
    expect([timeline.dataset.orbShown, sidebar.dataset.orbShown]).toEqual(["connecting", "connecting"]);
    fake.advance(ORB_MIN_DWELL_MS);
    fake.runFrames();
    expect([timeline.dataset.orbShown, sidebar.dataset.orbShown]).toEqual(["composing", "composing"]);
    expect(loop.stats().channels).toBe(1);
    b.dispose();
    const remounted = fakeCanvas();
    loop.register(remounted as never, 14, CONFIG, "conversation:one");
    expect(remounted.dataset.orbShown).toBe("composing");
  });

  it("resumes a conversation orb within the grace period after its last remount", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const handle = loop.register(fakeCanvas() as never, 14, { ...CONFIG, design: "weaving" }, "conversation:two");
    handle.dispose();
    fake.advance(ORB_CHANNEL_GRACE_MS - 1);
    const canvas = fakeCanvas();
    loop.register(canvas as never, 14, { ...CONFIG, design: "weaving" }, "conversation:two");
    expect(canvas.dataset.orbShown).toBe("weaving");
    expect(loop.stats().channels).toBe(1);
  });

  it("draws the glow inside the transparent canvas from the frame's own dots", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    const canvas = fakeCanvas();
    const handle = loop.register(canvas as never, 18, { ...CONFIG, color: "accent", glow: true });
    expect(canvas.style.filter).toBe("");
    expect(canvas.fills).toEqual([]);
    expect(canvas.images).toBe(1);
    expect(canvas.filters).toHaveLength(1);
    expect(canvas.filters[0]).toMatch(/^blur\(\d+(\.\d+)?px\)$/u);
    expect(fake.glowLayers).toHaveLength(1);
    expect(fake.glowLayers[0]!.arcs).toBeGreaterThan(0);
    fake.state.dark = false;
    fake.emit();
    fake.runFrames();
    expect(canvas.images).toBe(2);
    handle.update({ ...CONFIG, color: "ink", glow: true });
    const images = canvas.images;
    fake.runFrames();
    expect(canvas.images).toBe(images);
    expect(canvas.fills).toEqual([]);
  });

  it("caps animated painting at about 30 frames per second", () => {
    const fake = fakeEnvironment();
    const loop = createOrbLoop(fake.environment);
    loop.register(fakeCanvas() as never, 18, CONFIG);
    const start = loop.stats().paints;
    for (let frame = 0; frame < 60; frame += 1) {
      fake.advance(1_000 / 60);
      fake.runFrames();
    }
    expect(loop.stats().paints - start).toBeGreaterThanOrEqual(28);
    expect(loop.stats().paints - start).toBeLessThanOrEqual(31);
  });

  it("uses the 20px design below 36px and the 64px design above", () => {
    expect(tunedOrbSize(14)).toBe(20);
    expect(tunedOrbSize(18)).toBe(20);
    expect(tunedOrbSize(35)).toBe(20);
    expect(tunedOrbSize(36)).toBe(64);
    expect(tunedOrbSize(44)).toBe(64);
  });
});
