import type { Rectangle, WebContents } from "electron";

import {
  AGENT_BROWSER_VIEWPORT_SIZES,
  type AgentBrowserColorScheme,
  type AgentBrowserViewport,
  type AgentBrowserViewportPreset,
} from "../shared/agent-browser.js";
import { previewNavigationTarget } from "../shared/preview-url.js";

export const PARKED_PREVIEW_BOUNDS: Rectangle = { x: 0, y: 0, width: 1_280, height: 800 };

export interface AgentViewportSize {
  width: number;
  height: number;
  mobile: boolean;
}

export interface AgentViewportSetting {
  viewport: AgentViewportSize | null;
  colorScheme: AgentBrowserColorScheme;
}

export interface AgentViewportChange {
  preset?: AgentBrowserViewportPreset;
  width?: number;
  height?: number;
  colorScheme?: AgentBrowserColorScheme;
}

export interface AgentViewportLayout {
  bounds: Rectangle;
  scale: number;
}

export interface AgentPageVisualViewport {
  pageX: number;
  pageY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  scale: number;
}

export interface AgentPagePointMap {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface AgentPageEmulation extends AgentViewportSetting {
  scale: number;
}

const DEFAULT_EMULATION: AgentPageEmulation = { viewport: null, colorScheme: "system", scale: 1 };
const desiredEmulations = new WeakMap<WebContents, AgentPageEmulation>();
const appliedEmulations = new WeakMap<WebContents, AgentPageEmulation | "unknown">();
const emulationQueues = new WeakMap<WebContents, Promise<void>>();

export function agentViewportState(
  session: AgentViewportSetting & { bounds: Rectangle | null },
): AgentBrowserViewport {
  const size = session.viewport ?? session.bounds ?? PARKED_PREVIEW_BOUNDS;
  return {
    width: size.width,
    height: size.height,
    fit: session.viewport === null,
    mobile: session.viewport?.mobile ?? false,
    colorScheme: session.colorScheme,
  };
}

export function nextAgentViewport(
  current: AgentViewportSetting,
  change: AgentViewportChange,
): AgentViewportSetting {
  let viewport = current.viewport;
  if (change.preset === "fit") viewport = null;
  else if (change.preset) viewport = { ...AGENT_BROWSER_VIEWPORT_SIZES[change.preset] };
  else if (change.width !== undefined && change.height !== undefined) {
    viewport = { width: change.width, height: change.height, mobile: false };
  }
  return { viewport, colorScheme: change.colorScheme ?? current.colorScheme };
}

export function sameAgentViewport(left: AgentViewportSetting, right: AgentViewportSetting): boolean {
  return left.colorScheme === right.colorScheme
    && left.viewport?.width === right.viewport?.width
    && left.viewport?.height === right.viewport?.height
    && left.viewport?.mobile === right.viewport?.mobile;
}

export function agentViewportLayout(
  stage: Rectangle | null,
  viewport: AgentViewportSize | null,
): AgentViewportLayout {
  if (!viewport) return { bounds: stage ?? PARKED_PREVIEW_BOUNDS, scale: 1 };
  if (!stage) return { bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height }, scale: 1 };
  const fitted = Math.min(stage.width / viewport.width, stage.height / viewport.height, 1);
  const width = Math.max(1, Math.round(viewport.width * fitted));
  const height = Math.max(1, Math.round(viewport.height * fitted));
  return {
    bounds: {
      x: stage.x + Math.floor((stage.width - width) / 2),
      y: stage.y + Math.floor((stage.height - height) / 2),
      width,
      height,
    },
    scale: width / viewport.width,
  };
}

export function agentDeviceMetricsOverride(viewport: AgentViewportSize, scale: number): Record<string, unknown> {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 0,
    mobile: viewport.mobile,
    scale,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    dontSetVisibleSize: true,
  };
}

export function agentEmulatedMedia(colorScheme: AgentBrowserColorScheme): Record<string, unknown> {
  return {
    features: colorScheme === "system" ? [] : [{ name: "prefers-color-scheme", value: colorScheme }],
  };
}

export function agentViewportActivityLabel(
  change: AgentViewportChange,
  viewport: AgentBrowserViewport,
): string {
  if (change.preset === undefined && change.width === undefined) {
    return viewport.colorScheme === "system"
      ? "Agent restored the system colour scheme"
      : `Agent set the ${viewport.colorScheme} colour scheme`;
  }
  return viewport.fit
    ? "Agent fitted the viewport to the panel"
    : `Agent set the viewport to ${viewport.width}×${viewport.height}`;
}

function sameMetrics(left: AgentPageEmulation, right: AgentPageEmulation): boolean {
  if (left.viewport === null || right.viewport === null) return left.viewport === right.viewport;
  return left.viewport.width === right.viewport.width
    && left.viewport.height === right.viewport.height
    && left.viewport.mobile === right.viewport.mobile
    && left.scale === right.scale;
}

async function sendAgentPageEmulation(contents: WebContents): Promise<void> {
  const desired = desiredEmulations.get(contents) ?? DEFAULT_EMULATION;
  const applied = appliedEmulations.get(contents) ?? DEFAULT_EMULATION;
  const metricsChanged = applied === "unknown" || !sameMetrics(applied, desired);
  const mediaChanged = applied === "unknown" || applied.colorScheme !== desired.colorScheme;
  if ((!metricsChanged && !mediaChanged) || contents.isDestroyed() || !contents.debugger.isAttached()) return;
  appliedEmulations.set(contents, "unknown");
  if (metricsChanged && desired.viewport) {
    await contents.debugger.sendCommand(
      "Emulation.setDeviceMetricsOverride",
      agentDeviceMetricsOverride(desired.viewport, desired.scale),
    );
  } else if (metricsChanged) {
    await contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
  }
  if (mediaChanged) {
    await contents.debugger.sendCommand("Emulation.setEmulatedMedia", agentEmulatedMedia(desired.colorScheme));
  }
  appliedEmulations.set(contents, desired);
}

function queueAgentPageEmulation(contents: WebContents): Promise<void> {
  const previous = emulationQueues.get(contents) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => sendAgentPageEmulation(contents));
  emulationQueues.set(contents, next);
  return next;
}

export function setAgentPageEmulation(
  contents: WebContents,
  setting: AgentViewportSetting,
  scale: number,
): Promise<void> {
  desiredEmulations.set(contents, { viewport: setting.viewport, colorScheme: setting.colorScheme, scale });
  return queueAgentPageEmulation(contents);
}

function localAgentPage(url: string): boolean {
  try {
    return previewNavigationTarget(url).kind === "embed";
  } catch {
    return false;
  }
}

export async function emulateAgentPreviewPage(
  contents: WebContents,
  setting: AgentViewportSetting,
  scale: number,
  attach: (contents: WebContents) => Promise<void>,
): Promise<void> {
  await setAgentPageEmulation(contents, setting, scale);
  const emulated = setting.viewport !== null || setting.colorScheme !== "system";
  if (emulated && !contents.debugger.isAttached() && localAgentPage(contents.getURL())) await attach(contents);
}

export function resetAgentPageEmulation(contents: WebContents): void {
  appliedEmulations.delete(contents);
}

export function restoreAgentPageEmulation(contents: WebContents): Promise<void> {
  return queueAgentPageEmulation(contents);
}

function finiteMetric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export async function agentPageVisualViewport(contents: WebContents): Promise<AgentPageVisualViewport> {
  const metrics = await contents.debugger.sendCommand("Page.getLayoutMetrics") as {
    cssVisualViewport?: Record<string, unknown>;
  } | undefined;
  const visual = metrics?.cssVisualViewport;
  const { pageX, pageY, offsetX, offsetY, clientWidth, clientHeight, scale } = visual ?? {};
  if (!finiteMetric(pageX) || !finiteMetric(pageY) || !finiteMetric(offsetX) || !finiteMetric(offsetY)
    || !finiteMetric(clientWidth) || !finiteMetric(clientHeight) || !finiteMetric(scale)
    || clientWidth <= 0 || clientHeight <= 0 || scale <= 0) {
    throw new Error("Inertia could not read the Browser page viewport. Reload the page, then try again.");
  }
  return { pageX, pageY, offsetX, offsetY, width: clientWidth, height: clientHeight, scale };
}

export async function agentPagePointMap(
  contents: WebContents,
  layout: AgentViewportLayout,
): Promise<AgentPagePointMap> {
  const visual = await agentPageVisualViewport(contents);
  return {
    scale: layout.scale * visual.scale,
    offsetX: visual.offsetX,
    offsetY: visual.offsetY,
    width: layout.bounds.width,
    height: layout.bounds.height,
  };
}

export function agentPageViewPoint(
  map: AgentPagePointMap,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const viewX = (x - map.offsetX) * map.scale;
  const viewY = (y - map.offsetY) * map.scale;
  return Number.isFinite(viewX) && Number.isFinite(viewY)
    && viewX >= 0 && viewY >= 0 && viewX < map.width && viewY < map.height
    ? { x: viewX, y: viewY }
    : null;
}
