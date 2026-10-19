import { describe, expect, it, vi } from "vitest";

import {
  AppControlNative,
  AppControlNativeFailure,
  fitSnapshot,
  isSensitiveElement,
  sensitiveControlName,
  type NativeApp,
  type NativeElement,
  type NativeModule,
} from "../../src/main/app-control-native";
import {
  APP_CONTROL_MAX_PAYLOAD_BYTES,
  appControlPayloadBytes,
  parseAppControlResult,
} from "../../src/node/runtime-app-control-protocol";

class XA11yError extends Error {}
const errors = {
  PermissionDeniedError: class extends XA11yError {},
  AccessibilityNotEnabledError: class extends XA11yError {},
  SelectorNotMatchedError: class extends XA11yError {},
  ActionNotSupportedError: class extends XA11yError {},
  InvalidActionDataError: class extends XA11yError {},
};

type FakeElement = NativeElement & { calls: string[] };

function element(overrides: Partial<NativeElement> & { kids?: FakeElement[] } = {}): FakeElement {
  const calls: string[] = [];
  const { kids = [], ...rest } = overrides;
  const action = (name: string) => vi.fn(async (value?: string) => { calls.push(value === undefined ? name : `${name}:${value}`); });
  return {
    role: "button", name: null, value: null, stableId: null, pid: 10, actions: [], bounds: null, raw: {},
    enabled: true, visible: true, focused: false, active: false, checked: null, expanded: null, editable: false,
    children: async () => kids,
    press: action("press"), focus: action("focus"), toggle: action("toggle"), select: action("select"), expand: action("expand"),
    scrollIntoView: action("scrollIntoView"), setValue: action("setValue"), typeText: action("typeText"),
    activate: action("activate"),
    calls,
    ...rest,
  } as FakeElement;
}

function app(name: string, pid: number | null, windows: FakeElement[], raw: Record<string, unknown> = {}): NativeApp {
  return { name, pid, windows: vi.fn(async () => windows), asElement: () => ({ raw }) };
}

function form() {
  const save = element({ role: "push_button", name: "Save", stableId: "save", actions: ["press"], bounds: { x: 110, y: 120, width: 40, height: 20 } });
  const user = element({ role: "text_field", name: "User name", value: "ada", stableId: "user", editable: true, bounds: { x: 110, y: 150, width: 100, height: 20 } });
  const password = element({ role: "password_text", name: "Password", value: "hunter22", stableId: "password", editable: true, bounds: { x: 110, y: 180, width: 100, height: 20 } });
  const token = element({ role: "text_field", name: "API key", value: "sk-secret", stableId: "api", editable: true, bounds: { x: 110, y: 210, width: 100, height: 20 } });
  const label = element({ role: "static_text", name: "Welcome back", stableId: "label" });
  const icon = element({ role: "image", stableId: "icon" });
  const remember = element({ role: "check_box", name: "Remember me", stableId: "remember", checked: "off", actions: ["toggle"] });
  const panel = element({ role: "panel", stableId: "panel", kids: [label, icon, save, user, password, token, remember] });
  const window = element({ role: "window", name: "Fixture window", stableId: "main", active: true, bounds: { x: 100, y: 100, width: 400, height: 300 }, kids: [panel] });
  return { window, panel, save, user, password, token, label, icon, remember };
}

function fixture(apps: NativeApp[], options: ConstructorParameters<typeof AppControlNative>[1] = {}) {
  const native: NativeModule = { App: { list: vi.fn(async () => apps) }, errors };
  return { native, control: new AppControlNative(native, options) };
}

const scope = { pids: new Set([10, 11, 12]), deniedPids: new Set<number>() };

describe("App control worker logic", () => {
  it("lists only windows of the owned process tree, denied apps without a token or their windows read", async () => {
    const { window } = form();
    const outside = element({ role: "window", name: "Someone else", stableId: "outside" });
    const vault = element({ role: "window", name: "Vault", stableId: "vault" });
    const vaultApp = app("Bitwarden", 11, [vault]);
    const { control } = fixture([
      app("Fixture", 10, [window]),
      app("Other", 99, [outside]),
      vaultApp,
      app("Inertia", 12, [element({ role: "window", stableId: "inertia" })]),
    ]);
    const listed = await control.windows({ ...scope, deniedPids: new Set([12]) });
    expect(listed.windows).toEqual([
      { token: expect.stringMatching(/^[0-9a-f]{32}$/u), pid: 10, title: "Fixture window", active: true, denied: false, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { token: null, pid: 11, title: "", active: false, denied: true, bounds: null },
      { token: null, pid: 12, title: "", active: false, denied: true, bounds: null },
    ]);
    expect(vaultApp.windows).not.toHaveBeenCalled();
    // The token is stable across reads and never addresses a denied window.
    expect((await control.windows(scope)).windows[0]!.token).toBe(listed.windows[0]!.token);
    await expect(control.snapshot(scope, "f".repeat(32))).rejects.toMatchObject({ code: "not-found", reason: "window-gone" });
  });

  it("denies by bundle id and refuses windows of elevated processes", async () => {
    const { window } = form();
    const keychain = fixture([app("Renamed", 10, [window], { ax_bundle_id: "com.apple.keychainaccess" })]);
    expect((await keychain.control.windows(scope)).windows).toEqual([expect.objectContaining({ denied: true, token: null })]);
    const elevated = fixture([app("Fixture", 10, [window])], { elevated: (pid) => pid === 10 });
    const [listed] = (await elevated.control.windows(scope)).windows;
    await expect(elevated.control.snapshot(scope, listed!.token!)).rejects.toMatchObject({ code: "elevated" });
  });

  it("builds a Browser-shaped snapshot with sensitive values redacted at the source", async () => {
    const { window } = form();
    const { control } = fixture([app("Fixture", 10, [window])]);
    const [listed] = (await control.windows(scope)).windows;
    const snapshot = await control.snapshot(scope, listed!.token!);
    expect(JSON.stringify(snapshot)).not.toContain("hunter22");
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
    expect(snapshot).toMatchObject({
      kind: "snapshot", title: "Fixture window", text: "Welcome back", unlabelled: true, sensitiveFilled: true, readLimitReached: false,
    });
    expect(snapshot.elements.map(({ role, name, value, sensitive, editable }) => ({ role, name, value, sensitive, editable }))).toEqual([
      { role: "push_button", name: "Save", value: null, sensitive: false, editable: false },
      { role: "text_field", name: "User name", value: "ada", sensitive: false, editable: true },
      { role: "password_text", name: "Password", value: "[redacted]", sensitive: true, editable: true },
      { role: "text_field", name: "API key", value: "[redacted]", sensitive: true, editable: true },
      { role: "check_box", name: "Remember me", value: null, sensitive: false, editable: false },
    ]);
    expect(snapshot.elements[0]!.rect).toEqual({ x: 10, y: 20, width: 40, height: 20 });
    const again = await control.snapshot(scope, listed!.token!);
    expect(again.elements.map(({ token }) => token)).toEqual(snapshot.elements.map(({ token }) => token));
    expect(again.rootKey).toBe(snapshot.rootKey);
  });

  it("changes the root key when the window's content root is replaced", async () => {
    const parts = form();
    const kids = [parts.panel];
    const window = element({ ...parts.window, children: async () => kids } as Partial<NativeElement>);
    const { control } = fixture([app("Fixture", 10, [window])]);
    const [listed] = (await control.windows(scope)).windows;
    const before = await control.snapshot(scope, listed!.token!);
    kids[0] = element({ role: "panel", stableId: "panel-2" });
    expect((await control.snapshot(scope, listed!.token!)).rootKey).not.toBe(before.rootKey);
  });

  it("bounds the walk by depth and node visits and reports the read limit", async () => {
    let deep = element({ role: "push_button", name: "Deep", stableId: "deep" });
    for (let depth = 0; depth < 20; depth += 1) deep = element({ role: "group", stableId: `g${depth}`, kids: [deep] });
    const wide = element({ role: "group", stableId: "wide", kids: Array.from({ length: 5_000 }, (_, index) => element({ role: "static_text", name: `Row ${index}` })) });
    const window = element({ role: "window", name: "Big", stableId: "big", kids: [deep, wide] });
    const { control } = fixture([app("Fixture", 10, [window])]);
    const [listed] = (await control.windows(scope)).windows;
    const snapshot = await control.snapshot(scope, listed!.token!);
    expect(snapshot.readLimitReached).toBe(true);
    expect(snapshot.elements.some((entry) => entry.name === "Deep")).toBe(false);
    expect(appControlPayloadBytes({ ok: true, value: snapshot })).toBeLessThanOrEqual(APP_CONTROL_MAX_PAYLOAD_BYTES);
    const clock = { now: 0 };
    const slow = fixture([app("Fixture", 10, [element({ ...window, children: async () => { clock.now += 4_000; return [wide]; } } as Partial<NativeElement>)])], { now: () => clock.now });
    const [slowWindow] = (await slow.control.windows(scope)).windows;
    expect((await slow.control.snapshot(scope, slowWindow!.token!)).readLimitReached).toBe(true);
  });

  it("performs accessibility actions only, on the element the token names", async () => {
    const parts = form();
    const { control } = fixture([app("Fixture", 10, [parts.window])]);
    const [listed] = (await control.windows(scope)).windows;
    const snapshot = await control.snapshot(scope, listed!.token!);
    const [save, user, , , remember] = snapshot.elements;
    await expect(control.perform(scope, listed!.token!, save!.token, "press", null, null)).resolves.toEqual({ kind: "perform", rootKey: snapshot.rootKey, windowClosed: false });
    expect(parts.save.calls).toEqual(["press"]);
    await control.perform(scope, listed!.token!, user!.token, "setValue", "grace", null);
    expect(parts.user.calls).toEqual(["focus", "setValue:grace"]);
    await control.perform(scope, listed!.token!, user!.token, "typeText", "!", null);
    expect(parts.user.calls.slice(-2)).toEqual(["focus", "typeText:!"]);
    await control.perform(scope, listed!.token!, remember!.token, "toggle", null, null);
    expect(parts.remember.calls).toEqual(["toggle"]);
    await expect(control.perform(scope, listed!.token!, save!.token, "setValue", "x", null)).rejects.toMatchObject({ code: "invalid", reason: "not-editable", dispatched: false });
    await expect(control.perform(scope, listed!.token!, "c".repeat(32), "press", null, null)).rejects.toMatchObject({ code: "not-found", reason: "stale" });
    // The focused control answers a key press when no element is named.
    await expect(control.perform(scope, listed!.token!, null, "press", null, null)).rejects.toMatchObject({ code: "invalid", reason: "no-focus" });
    await control.perform(scope, listed!.token!, null, "activate", null, null);
    expect(parts.window.calls).toEqual(["activate"]);
  });

  it("refuses an approved action when the root or the target changed", async () => {
    const parts = form();
    const { control } = fixture([app("Fixture", 10, [parts.window])]);
    const [listed] = (await control.windows(scope)).windows;
    const snapshot = await control.snapshot(scope, listed!.token!);
    const save = snapshot.elements[0]!;
    const expect_ = { rootKey: snapshot.rootKey, role: "push_button", name: "Save" };
    await expect(control.perform(scope, listed!.token!, save.token, "press", null, { ...expect_, rootKey: "d".repeat(32) })).rejects.toMatchObject({ code: "not-found", reason: "changed" });
    await expect(control.perform(scope, listed!.token!, save.token, "press", null, { ...expect_, name: "Delete" })).rejects.toMatchObject({ code: "not-found", reason: "changed" });
    await expect(control.perform(scope, listed!.token!, save.token, "press", null, { ...expect_, role: "link" })).rejects.toMatchObject({ code: "not-found", reason: "changed" });
    expect(parts.save.calls).toEqual([]);
    await control.perform(scope, listed!.token!, save.token, "press", null, expect_);
    expect(parts.save.calls).toEqual(["press"]);
  });

  it("maps native errors to typed categories and says whether the action may have run", async () => {
    const parts = form();
    const { control } = fixture([app("Fixture", 10, [parts.window])]);
    const [listed] = (await control.windows(scope)).windows;
    const save = (await control.snapshot(scope, listed!.token!)).elements[0]!;
    for (const [error, code, dispatched] of [
      [new errors.ActionNotSupportedError(), "invalid", false],
      [new errors.PermissionDeniedError(), "permission-denied", true],
      [new errors.AccessibilityNotEnabledError(), "accessibility-unavailable", true],
      [new Error("boom with app text"), "native-failure", true],
    ] as const) {
      (parts.save.press as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
      const failure = await control.perform(scope, listed!.token!, save.token, "press", null, null).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(AppControlNativeFailure);
      expect(failure).toMatchObject({ code, dispatched });
      expect((failure as Error).message).not.toContain("app text");
    }
    const disabled = form();
    const off = element({ ...disabled.save, enabled: false } as Partial<NativeElement>);
    const window = element({ ...disabled.window, children: async () => [off] } as Partial<NativeElement>);
    const locked = fixture([app("Fixture", 10, [window])]);
    const [lockedWindow] = (await locked.control.windows(scope)).windows;
    const lockedSave = (await locked.control.snapshot(scope, lockedWindow!.token!)).elements[0]!;
    await expect(locked.control.perform(scope, lockedWindow!.token!, lockedSave.token, "press", null, null)).rejects.toMatchObject({ code: "invalid", reason: "disabled" });
  });

  it("reports a closed window after the action", async () => {
    const parts = form();
    const windows = [parts.window];
    const { control } = fixture([app("Fixture", 10, windows)]);
    const [listed] = (await control.windows(scope)).windows;
    const save = (await control.snapshot(scope, listed!.token!)).elements[0]!;
    (parts.save.press as ReturnType<typeof vi.fn<() => Promise<void>>>).mockImplementationOnce(async () => { windows.length = 0; });
    await expect(control.perform(scope, listed!.token!, save.token, "press", null, null)).resolves.toEqual({ kind: "perform", rootKey: null, windowClosed: true });
  });

  it("plans a screenshot: masks protected fields and withholds a filled sensitive field or an incomplete scan", async () => {
    const parts = form();
    const { control } = fixture([app("Fixture", 10, [parts.window])]);
    const resolved = await control.resolve(scope, (await control.windows(scope)).windows[0]!.token!);
    await expect(control.screenshotPlan(resolved)).rejects.toMatchObject({ code: "sensitive", reason: null });
    const empty = form();
    const password = element({ ...empty.password, value: "" } as Partial<NativeElement>);
    const token = element({ ...empty.token, value: null } as Partial<NativeElement>);
    const panel = element({ role: "panel", stableId: "panel", kids: [empty.label, empty.save, empty.user, password, token] });
    const window = element({ ...empty.window, children: async () => [panel] } as Partial<NativeElement>);
    const clean = fixture([app("Fixture", 10, [window])]);
    const cleanWindow = await clean.control.resolve(scope, (await clean.control.windows(scope)).windows[0]!.token!);
    const plan = await clean.control.screenshotPlan(cleanWindow);
    expect(plan.bounds).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(plan.masks).toEqual([empty.user.bounds, password.bounds, token.bounds]);
    const unlocated = element({ role: "text_field", editable: true, stableId: "floating" });
    const floating = fixture([app("Fixture", 10, [element({ ...empty.window, children: async () => [unlocated] } as Partial<NativeElement>)])]);
    const floatingWindow = await floating.control.resolve(scope, (await floating.control.windows(scope)).windows[0]!.token!);
    await expect(floating.control.screenshotPlan(floatingWindow)).rejects.toMatchObject({ code: "sensitive", reason: "incomplete" });
  });

  it("makes a renamed control without a stableId at the same position a different, stale control", async () => {
    const button = element({ role: "push_button", name: "Save", actions: ["press"] });
    const kids = [button];
    const panel = element({ role: "panel", children: async () => kids } as Partial<NativeElement>);
    const window = element({ role: "window", name: "Form", stableId: "form", kids: [panel] });
    const { control } = fixture([app("Fixture", 10, [window])]);
    const [listed] = (await control.windows(scope)).windows;
    const before = await control.snapshot(scope, listed!.token!);
    kids[0] = element({ role: "push_button", name: "Delete everything", actions: ["press"] });
    const after = await control.snapshot(scope, listed!.token!);
    // The content root is the same document; only the control changed.
    expect(after.rootKey).toBe(before.rootKey);
    expect(after.elements[0]!.token).not.toBe(before.elements[0]!.token);
    await expect(control.perform(scope, listed!.token!, before.elements[0]!.token, "press", null, null)).rejects.toMatchObject({ code: "not-found", reason: "stale" });
    expect((kids[0] as FakeElement).calls).toEqual([]);
  });

  it("cuts window titles in the worker and fits the window list to the payload bound, counting what it left out", async () => {
    const title = "窗".repeat(2_000);
    const windows = Array.from({ length: 16 }, (_, index) => element({ role: "window", name: title, stableId: `w${index}` }));
    const { control } = fixture([app("Fixture", 10, windows), app("Other", 11, [element({ role: "window", stableId: "x" })])]);
    const listed = await control.windows(scope);
    expect(listed.windows.every(({ title: cut }) => cut.length <= 480)).toBe(true);
    expect(listed.windows.length).toBeLessThan(16);
    expect(listed.windows.length + listed.omitted).toBe(17);
    // The newest (last listed) windows are the ones left out.
    expect(listed.windows.map(({ token }) => token)).toEqual((await control.listWindows(scope)).slice(0, listed.windows.length).map(({ token }) => token));
    expect(appControlPayloadBytes({ ok: true, value: listed })).toBeLessThanOrEqual(APP_CONTROL_MAX_PAYLOAD_BYTES);
    expect(parseAppControlResult({ ok: true, value: listed }, "windows")).not.toBeNull();
  });

  it("reports a Linux window with an empty accessibility root as the app not exposing its tree", async () => {
    const empty = element({ role: "frame", name: "Electron", stableId: "empty" });
    const linux = fixture([app("Fixture", 10, [empty])], { platform: "linux" });
    const [listed] = (await linux.control.windows(scope)).windows;
    await expect(linux.control.snapshot(scope, listed!.token!)).rejects.toMatchObject({ code: "accessibility-unavailable", reason: "empty-tree" });
    const mac = fixture([app("Fixture", 10, [empty])], { platform: "darwin" });
    const [macWindow] = (await mac.control.windows(scope)).windows;
    await expect(mac.control.snapshot(scope, macWindow!.token!)).resolves.toMatchObject({ kind: "snapshot", elements: [] });
    // A disabled bus keeps its own category, without the empty-tree reason.
    const off = fixture([]);
    (off.native.App.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new errors.AccessibilityNotEnabledError());
    await expect(off.control.windows({ pids: new Set(), deniedPids: new Set() })).rejects.toBeInstanceOf(errors.AccessibilityNotEnabledError);
  });

  it("looks a small tree up pid by pid and lists every application only for a large or empty scope", async () => {
    const { window } = form();
    const fixtureApp = app("Fixture", 10, [window]);
    const byPid = vi.fn(async (pid: number) => (pid === 10 ? fixtureApp : null));
    const list = vi.fn(async () => [fixtureApp]);
    const control = new AppControlNative({ App: { list, byPid }, errors });
    expect((await control.windows(scope)).windows).toHaveLength(1);
    expect(byPid.mock.calls.map(([pid]) => pid)).toEqual([10, 11, 12]);
    expect(list).not.toHaveBeenCalled();
    await control.windows({ pids: new Set(Array.from({ length: 17 }, (_, index) => 10 + index)), deniedPids: new Set() });
    await control.windows({ pids: new Set(), deniedPids: new Set() });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("classifies sensitive controls with the Browser's credential words", () => {
    expect(sensitiveControlName("Password")).toBe(true);
    expect(sensitiveControlName("One-time code")).toBe(true);
    expect(sensitiveControlName("apiKey")).toBe(true);
    expect(sensitiveControlName("User name")).toBe(false);
    expect(isSensitiveElement({ role: "text", raw: { atspi_role: "password text" }, name: null, editable: true })).toBe(true);
    expect(isSensitiveElement({ role: "text_field", raw: { ax_subrole: "AXSecureTextField" }, name: null, editable: true })).toBe(true);
    expect(isSensitiveElement({ role: "static_text", raw: {}, name: "Password", editable: false })).toBe(false);
  });

  it("fits a large snapshot into the worker payload bound", () => {
    const value = {
      kind: "snapshot" as const, rootKey: "a".repeat(32), title: "t", bounds: null, text: "x".repeat(12_000),
      elements: Array.from({ length: 200 }, (_, index) => ({
        token: index.toString(16).padStart(32, "0"), role: "button", name: "n".repeat(300), value: null, enabled: true, focused: false,
        checked: null, expanded: null, editable: false, sensitive: false, offscreen: index % 2 === 0, rect: null, actions: [],
      })),
      omittedTextChars: 0, omittedElements: 0, readLimitReached: false, unlabelled: false, sensitiveFilled: false,
    };
    const fitted = fitSnapshot(value);
    expect(appControlPayloadBytes({ ok: true, value: fitted })).toBeLessThanOrEqual(APP_CONTROL_MAX_PAYLOAD_BYTES);
    expect(fitted.omittedElements + fitted.elements.length).toBe(200);
    expect(fitted.omittedTextChars + fitted.text.length).toBe(12_000);
    expect(fitted.elements.every((entry) => !entry.offscreen) || fitted.elements.length > 100).toBe(true);
  });
});
