import type {
  OrbDesign,
  WorkingIndicatorColor,
} from "@shared/working-indicator";
import { MODE_FRAMES, resolvePreset, type OrbFrame, type OrbSize } from "../../vendor/thinking-orbs";
import {
  advanceOrbDwell,
  createOrbDwell,
  orbCrossfade,
  orbDwellDeadline,
  requestOrbDesign,
  type OrbDwellState,
} from "./orbDwell";
import {
  contrastLiftForSize,
  orbBleed,
  orbGlowStyle,
  orbInkPalette,
  paintOrbLayers,
  parseCssRgb,
  type OrbGlow,
  type OrbPaintLayer,
  type Rgb,
} from "./orbPaint";

export interface OrbGlowLayer {
  canvas: CanvasImageSource & { width: number; height: number };
  context: OrbGlow["context"];
}

export const ORB_STILL_TIME = 0.6;
export const ORB_COLOR_RECHECK_MS = 1_000;
export const ORB_MAX_PIXEL_RATIO = 2;
export const ORB_LARGE_DESIGN_MIN_SIZE = 36;
export const ORB_CHANNEL_GRACE_MS = 2_000;
export const ORB_FRAME_INTERVAL_MS = 1_000 / 30;
export const ORB_GLOW_LAYER_SCALE = 0.5;

export const ORB_PRESET_COLORS: Readonly<Record<Exclude<WorkingIndicatorColor, "ink" | "accent" | "custom">, string>> = {
  lilac: "#c77dff",
  sky: "#38bdf8",
  mint: "#34d399",
  amber: "#fbbf24",
  rose: "#fb7185",
};

export interface OrbConfig {
  design: OrbDesign;
  pace: number;
  speed: number;
  color: WorkingIndicatorColor;
  customColor: string;
  glow: boolean;
}

export interface OrbLoopEnvironment {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  isDocumentHidden(): boolean;
  prefersReducedMotion(): boolean;
  forcedColors(): boolean;
  isDarkTheme(): boolean;
  devicePixelRatio(): number;
  resolveColor(element: Element, source: "accent" | "text"): string | null;
  subscribe(listener: () => void): () => void;
  observeIntersection(element: Element, listener: (visible: boolean) => void): () => void;
  createGlowLayer(width: number, height: number): OrbGlowLayer | null;
}

export interface OrbHandle {
  update(config: OrbConfig): void;
  dispose(): void;
}

export interface OrbLoopStats {
  mounted: number;
  visible: number;
  frameScheduled: boolean;
  timerScheduled: boolean;
  subscribed: boolean;
  channels: number;
  paints: number;
}

export interface OrbLoop {
  register(canvas: HTMLCanvasElement, size: number, config: OrbConfig, syncKey?: string | null): OrbHandle;
  stats(): OrbLoopStats;
}

interface OrbChannel {
  key: string | null;
  dwell: OrbDwellState;
  clockOffset: number;
  clockRate: number;
  entries: Set<OrbEntry>;
  releaseTimer: number | null;
}

interface OrbEntry {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  size: number;
  tuned: OrbSize;
  config: OrbConfig;
  channel: OrbChannel;
  visible: boolean;
  dirty: boolean;
  pixelRatio: number;
  dark: boolean;
  rgb: Rgb | null;
  palette: string[];
  colorKey: string;
  colorCheckedAt: number;
  glow: boolean;
  glowLayer: OrbGlowLayer | null;
  stopObserving: () => void;
}

export function tunedOrbSize(size: number): OrbSize {
  return size >= ORB_LARGE_DESIGN_MIN_SIZE ? 64 : 20;
}

function clockRate(config: OrbConfig): number {
  return Math.max(0, config.speed) * Math.max(0, config.pace);
}

export function createOrbLoop(environment: OrbLoopEnvironment): OrbLoop {
  const entries = new Set<OrbEntry>();
  const channels = new Map<string, OrbChannel>();
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let paints = 0;
  let lastAnimatedAt = Number.NEGATIVE_INFINITY;

  const localClock = (channel: OrbChannel, now: number): number =>
    channel.clockOffset + (now / 1_000) * channel.clockRate;

  const setChannelRate = (channel: OrbChannel, rate: number, now: number): void => {
    if (rate === channel.clockRate) return;
    const local = localClock(channel, now);
    channel.clockRate = rate;
    channel.clockOffset = local - (now / 1_000) * rate;
  };

  const acquireChannel = (key: string | null, config: OrbConfig, now: number): OrbChannel => {
    const existing = key === null ? undefined : channels.get(key);
    if (existing) {
      if (existing.releaseTimer !== null) {
        environment.clearTimer(existing.releaseTimer);
        existing.releaseTimer = null;
      }
      return existing;
    }
    const channel: OrbChannel = {
      key,
      dwell: createOrbDwell(config.design, now),
      clockOffset: 0,
      clockRate: clockRate(config),
      entries: new Set(),
      releaseTimer: null,
    };
    if (key !== null) channels.set(key, channel);
    return channel;
  };

  const releaseChannel = (channel: OrbChannel): void => {
    if (channel.entries.size > 0 || channel.key === null) return;
    const key = channel.key;
    channel.releaseTimer = environment.setTimer(() => {
      channel.releaseTimer = null;
      if (channel.entries.size === 0 && channels.get(key) === channel) channels.delete(key);
    }, ORB_CHANNEL_GRACE_MS);
  };

  const frameFor = (entry: OrbEntry, design: OrbDesign, now: number, reduced: boolean): OrbFrame => {
    const { mode, speed, opts } = resolvePreset(design, entry.tuned);
    const t = reduced ? ORB_STILL_TIME : localClock(entry.channel, now) * speed;
    return MODE_FRAMES[mode](entry.tuned, t, opts);
  };

  const refreshColor = (entry: OrbEntry, now: number): boolean => {
    entry.colorCheckedAt = now;
    const forced = environment.forcedColors();
    const dark = environment.isDarkTheme();
    const { color, customColor, glow } = entry.config;
    const rgb = forced
      ? parseCssRgb(environment.resolveColor(entry.canvas, "text"))
      : color === "ink"
        ? null
        : color === "accent"
          ? parseCssRgb(environment.resolveColor(entry.canvas, "accent"))
          : color === "custom"
            ? parseCssRgb(customColor)
            : parseCssRgb(ORB_PRESET_COLORS[color]);
    const glowing = glow && !forced && rgb !== null;
    if (!glowing) entry.glowLayer = null;
    const key = `${dark ? "dark" : "light"}|${rgb ? rgb.join(",") : "ink"}|${glowing ? "glow" : "matte"}`;
    entry.glow = glowing;
    const changed = key !== entry.colorKey;
    entry.colorKey = key;
    entry.dark = dark;
    entry.rgb = rgb;
    if (changed) entry.palette = orbInkPalette(dark, rgb, contrastLiftForSize(entry.size));
    return changed;
  };

  const paint = (entry: OrbEntry, now: number, reduced: boolean): void => {
    entry.dirty = false;
    const context = entry.context;
    if (!context) return;
    const ratio = Math.min(ORB_MAX_PIXEL_RATIO, Math.max(1, environment.devicePixelRatio() || 1));
    const bleed = orbBleed(entry.size);
    const pixels = Math.round((entry.size + bleed * 2) * ratio);
    if (entry.pixelRatio !== ratio || entry.canvas.width !== pixels) {
      entry.pixelRatio = ratio;
      entry.canvas.width = pixels;
      entry.canvas.height = pixels;
    }
    let glow: OrbGlow | null = null;
    if (entry.glow && entry.rgb) {
      const glowPixels = Math.max(1, Math.ceil(pixels * ORB_GLOW_LAYER_SCALE));
      if (!entry.glowLayer || entry.glowLayer.canvas.width !== glowPixels) {
        entry.glowLayer = environment.createGlowLayer(glowPixels, glowPixels);
      }
      if (entry.glowLayer) {
        const tuning = orbGlowStyle(entry.rgb, entry.dark, entry.size);
        glow = {
          context: entry.glowLayer.context,
          canvas: entry.glowLayer.canvas,
          rgb: tuning.rgb,
          blur: tuning.sigma * ratio,
          alpha: tuning.alpha,
          scale: ORB_GLOW_LAYER_SCALE,
        };
      }
    }
    const { previous, progress } = orbCrossfade(entry.channel.dwell, now, reduced);
    const layers: OrbPaintLayer[] = [];
    if (previous) layers.push({ frame: frameFor(entry, previous, now, reduced), alpha: 1 - progress });
    layers.push({ frame: frameFor(entry, entry.channel.dwell.shown, now, reduced), alpha: progress });
    paintOrbLayers(context, layers, {
      scale: (entry.size / entry.tuned) * ratio,
      offset: bleed * ratio,
      width: pixels,
      height: pixels,
      palette: entry.palette,
      glow,
    });
    paints += 1;
  };

  const cancelFrame = (): void => {
    if (frameHandle === null) return;
    environment.cancelFrame(frameHandle);
    frameHandle = null;
  };

  const cancelTimer = (): void => {
    if (timerHandle === null) return;
    environment.clearTimer(timerHandle);
    timerHandle = null;
  };

  const requestFrame = (): void => {
    if (frameHandle !== null) return;
    frameHandle = environment.requestFrame(tick);
  };

  function schedule(): void {
    cancelTimer();
    const visible = [...entries].filter((entry) => entry.visible);
    if (visible.length === 0 || environment.isDocumentHidden()) {
      cancelFrame();
      return;
    }
    if (!environment.prefersReducedMotion() || visible.some((entry) => entry.dirty)) {
      requestFrame();
      return;
    }
    cancelFrame();
    const now = environment.now();
    let wake = now + ORB_COLOR_RECHECK_MS;
    for (const entry of visible) {
      const deadline = orbDwellDeadline(entry.channel.dwell);
      if (deadline !== null) wake = Math.min(wake, deadline);
    }
    timerHandle = environment.setTimer(() => {
      timerHandle = null;
      requestFrame();
    }, Math.max(0, wake - now));
  }

  function tick(): void {
    frameHandle = null;
    const now = environment.now();
    const reduced = environment.prefersReducedMotion();
    const hidden = environment.isDocumentHidden();
    const due = !reduced && now - lastAnimatedAt >= ORB_FRAME_INTERVAL_MS - 4;
    if (due) lastAnimatedAt = now;
    const advanced = new Set<OrbChannel>();
    for (const entry of entries) {
      if (!entry.visible || hidden) continue;
      const channel = entry.channel;
      if (!advanced.has(channel)) {
        advanced.add(channel);
        const before = channel.dwell;
        channel.dwell = advanceOrbDwell(channel.dwell, now);
        if (channel.dwell !== before) {
          for (const member of channel.entries) {
            member.dirty = true;
            member.canvas.dataset.orbShown = channel.dwell.shown;
          }
        }
      }
      if (now - entry.colorCheckedAt >= ORB_COLOR_RECHECK_MS && refreshColor(entry, now)) {
        entry.dirty = true;
      }
      if (due || entry.dirty) paint(entry, now, reduced);
    }
    schedule();
  }

  const environmentChanged = (): void => {
    const now = environment.now();
    for (const entry of entries) {
      refreshColor(entry, now);
      entry.dirty = true;
    }
    schedule();
  };

  const release = (entry: OrbEntry): void => {
    if (!entries.delete(entry)) return;
    entry.channel.entries.delete(entry);
    releaseChannel(entry.channel);
    entry.stopObserving();
    if (entries.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
    schedule();
  };

  return {
    register(canvas, size, config, syncKey = null) {
      const now = environment.now();
      const channel = acquireChannel(syncKey, config, now);
      if (channel.entries.size === 0) {
        channel.dwell = requestOrbDesign(channel.dwell, config.design, now);
        setChannelRate(channel, clockRate(config), now);
      }
      const entry: OrbEntry = {
        canvas,
        context: canvas.getContext("2d"),
        size,
        tuned: tunedOrbSize(size),
        config: { ...config },
        channel,
        visible: true,
        dirty: true,
        pixelRatio: 0,
        dark: false,
        rgb: null,
        palette: [],
        colorKey: "",
        colorCheckedAt: Number.NEGATIVE_INFINITY,
        glow: false,
        glowLayer: null,
        stopObserving: () => undefined,
      };
      canvas.dataset.orbShown = channel.dwell.shown;
      entries.add(entry);
      channel.entries.add(entry);
      if (!unsubscribe) unsubscribe = environment.subscribe(environmentChanged);
      entry.stopObserving = environment.observeIntersection(canvas, (visible) => {
        if (!entries.has(entry) || entry.visible === visible) return;
        entry.visible = visible;
        entry.dirty = true;
        schedule();
      });
      refreshColor(entry, now);
      if (!environment.isDocumentHidden()) paint(entry, now, environment.prefersReducedMotion());
      schedule();
      let disposed = false;
      return {
        update(next) {
          if (disposed) return;
          const current = entry.config;
          const changedAt = environment.now();
          setChannelRate(entry.channel, clockRate(next), changedAt);
          if (next.design !== current.design) {
            entry.channel.dwell = requestOrbDesign(entry.channel.dwell, next.design, changedAt);
          }
          entry.config = { ...next };
          if (
            next.color !== current.color
            || next.customColor !== current.customColor
            || next.glow !== current.glow
          ) {
            refreshColor(entry, changedAt);
          }
          entry.dirty = true;
          schedule();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          release(entry);
        },
      };
    },
    stats() {
      return {
        mounted: entries.size,
        visible: [...entries].filter((entry) => entry.visible).length,
        frameScheduled: frameHandle !== null,
        timerScheduled: timerHandle !== null,
        subscribed: unsubscribe !== null,
        channels: channels.size,
        paints,
      };
    },
  };
}
