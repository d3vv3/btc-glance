import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as helpers from "../src/lib/pwa-install";

describe("browser-aware install guidance", () => {
  it.each([
    ["iPhone Version/18.0 Safari/605.1", "iPhone", 1, "ios", "safari"],
    ["Macintosh Version/18.0 Safari/605.1", "MacIntel", 5, "ios", "safari"],
    ["iPad CriOS/130 Safari/605.1", "iPad", 5, "ios", "chrome"],
    ["iPhone FxiOS/130 Safari/605.1", "iPhone", 1, "ios", "firefox"],
    ["iPhone EdgiOS/130 Safari/605.1", "iPhone", 1, "ios", "edge"],
    ["Android Firefox/130", "Linux", 5, "android", "firefox"],
    ["Android Chrome/130 SamsungBrowser/27 Safari/537.36", "Linux", 5, "android", "samsung"],
    ["Android Chrome/130 EdgA/130 Safari/537.36", "Linux", 5, "android", "edge"],
    ["Android Chrome/130 Safari/537.36", "Linux", 5, "android", "chrome"],
    ["Android Chromium/130", "Linux", 5, "android", "chromium"],
    ["Windows Firefox/130", "Win32", 0, "desktop", "firefox"],
    ["Windows Chrome/130 Edg/130 Safari/537.36", "Win32", 0, "desktop", "edge"],
    ["Linux Chromium/130", "Linux", 0, "desktop", "chromium"],
    ["Macintosh Version/18.0 Safari/605.1", "MacIntel", 0, "desktop", "safari"],
    ["unrecognized", "", 0, "desktop", "unknown"],
  ])("detects %s", (ua, platform, touch, os, browser) => {
    expect(helpers.detectInstallBrowser(ua as string, platform as string, touch as number)).toEqual({ platform: os, browser });
  });
  it("offers iOS non-Safari support conditionally, with a Safari fallback", () => {
    for (const browser of ["chrome", "firefox", "edge"] as const) {
      const text = helpers.installInstructions({ platform: "ios", browser });
      expect(text).toContain("where supported");
      expect(text).toContain("Availability varies");
      expect(text).toContain("open this page in Safari");
    }
  });
  it("does not promise Firefox desktop installation or universal Safari support", () => {
    expect(helpers.installInstructions({ platform: "desktop", browser: "firefox" })).toContain("does not provide built-in");
    expect(helpers.installInstructions({ platform: "desktop", browser: "safari" })).toContain("macOS Sonoma or later");
  });
  it("recognizes only standalone, minimal-ui, or navigator.standalone", () => {
    expect(helpers.isInstalledDisplay(undefined, false, false)).toBe(false);
    expect(helpers.isInstalledDisplay(true, false, false)).toBe(true);
    expect(helpers.isInstalledDisplay(false, true, false)).toBe(true);
    expect(helpers.isInstalledDisplay(false, false, true)).toBe(true);
  });
});

// Exercise the actual component with deterministic hooks, without adding a DOM dependency.
function controls({ iosStandalone = false, display = "browser", production = false, storage = new Map<string, string>(), storageFails = false } = {}) {
  const slots: any[] = [];
  let index = 0;
  let mounted = false;
  const effects: (() => void | (() => void))[] = [];
  const window = new EventTarget() as EventTarget & { matchMedia: (query: string) => any; location: any };
  const media = new Map<string, EventTarget & { matches: boolean }>();
  window.matchMedia = query => {
    if (!media.has(query)) media.set(query, Object.assign(new EventTarget(), { matches: query === `(display-mode: ${display})` }));
    return media.get(query);
  };
  window.location = { reload: vi.fn() };
  const serviceWorker = Object.assign(new EventTarget(), { controller: { postMessage: vi.fn() }, register: vi.fn(async () => ({ waiting: { postMessage: vi.fn() }, addEventListener: vi.fn() })) });
  const navigator = { userAgent: "Windows Firefox/130", platform: "Win32", maxTouchPoints: 0, standalone: iosStandalone, serviceWorker };
  const react = {
    useState: (initial: any) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    },
    useRef: (initial: any) => { const slot = index++; return slots[slot] ??= { current: initial }; },
    useEffect: (effect: () => void) => { if (!mounted) effects.push(effect); },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: { PwaControls?: () => any } = {};
  const source = readFileSync(new URL("../src/components/PwaControls.tsx", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, window, navigator, localStorage: { getItem: (key: string) => { if (storageFails) throw new Error("Blocked"); return storage.get(key); }, setItem: (key: string, value: string) => { if (storageFails) throw new Error("Blocked"); storage.set(key, value); } }, process: { env: { NODE_ENV: production ? "production" : "test" } },
    require: (name: string) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" } : name.includes("pwa-install") ? helpers : name === "./Sheet" ? { Sheet: "sheet" } : { Download: "download", RefreshCw: "refresh" },
  });
  const render = () => { index = 0; return exports.PwaControls!(); };
  const nodes = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const all = () => nodes(render());
  const cleanup = () => effects.map(effect => effect()).filter(Boolean) as (() => void)[];
  const first = render();
  const stops = cleanup();
  mounted = true;
  const installButton = () => all().find(node => node.type === "button" && Array.isArray(node.props.children) && (node.props.children.includes("Install") || node.props.children.includes("Installing...")));
  return { window, media, first: nodes(first), all, installButton, unmount: () => stops.forEach(stop => stop()) };
}

function promptEvent(outcome: "accepted" | "dismissed") {
  let finish!: () => void;
  const choice = new Promise<{ outcome: string }>(resolve => { finish = () => resolve({ outcome }); });
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: vi.fn(async () => {}), userChoice: choice });
  return { event, finish };
}

describe("progressive install controls", () => {
  it("persists invitation dismissal without discarding native install capability", () => {
    const storage = new Map<string, string>();
    const ui = controls({ storage });
    ui.window.dispatchEvent(promptEvent("accepted").event);
    ui.all().find(node => node.props?.["aria-label"] === "Dismiss install invitation").props.onClick();
    expect(ui.all().some(node => node.props?.className === "install-invitation")).toBe(false);
    expect(ui.installButton()).toBeTruthy();
    ui.unmount();
    const reopened = controls({ storage });
    reopened.window.dispatchEvent(promptEvent("accepted").event);
    expect(reopened.all().some(node => node.props?.className === "install-invitation")).toBe(false);
    expect(reopened.installButton()).toBeTruthy();
    reopened.unmount();
  });
  it("keeps dismissal usable when storage is blocked and ignores malformed events", () => {
    const ui = controls({ storageFails: true });
    ui.window.dispatchEvent(new Event("beforeinstallprompt"));
    expect(ui.installButton()).toBeUndefined();
    ui.window.dispatchEvent(promptEvent("accepted").event);
    ui.all().find(node => node.props?.["aria-label"] === "Dismiss install invitation").props.onClick();
    expect(ui.all().some(node => node.props?.className === "install-invitation")).toBe(false);
    ui.unmount();
  });
  it("renders no instructions before mount", () => {
    const ui = controls();
    expect(ui.first.some(node => node.type === "sheet")).toBe(false);
    expect(ui.all().some(node => node.type === "sheet")).toBe(true);
    ui.unmount();
  });
  it.each(["accepted", "dismissed"] as const)("consumes %s prompt once, locks clicks, and does not infer installation", async outcome => {
    const ui = controls();
    const { event, finish } = promptEvent(outcome);
    ui.window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    const button = ui.installButton();
    expect(button).toBeTruthy(); // Feature event wins even on desktop Firefox.
    const request = button.props.onClick();
    expect(ui.installButton().props.disabled).toBe(true);
    await button.props.onClick();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    finish();
    await request;
    expect(ui.installButton()).toBeUndefined();
    expect(ui.all().some(node => node.type === "sheet")).toBe(true);
    expect(ui.all().find(node => node.props?.role === "status").props.children).toContain(outcome === "accepted" ? "Installation requested" : "Installation dismissed");
    ui.window.dispatchEvent(event);
    expect(ui.installButton()).toBeUndefined();
    ui.window.dispatchEvent(new Event("appinstalled"));
    expect(ui.all().some(node => node.type === "sheet")).toBe(false);
    ui.unmount();
  });
  it("consumes a failed prompt and returns to targeted guidance", async () => {
    const ui = controls();
    const { event } = promptEvent("accepted");
    event.prompt.mockRejectedValueOnce(new Error("Not available"));
    ui.window.dispatchEvent(event);
    await ui.installButton().props.onClick();
    expect(ui.installButton()).toBeUndefined();
    expect(ui.all().find(node => node.props?.role === "status").props.children).toContain("could not start");
    ui.unmount();
  });
  it.each([{ iosStandalone: true }, { display: "standalone" }, { display: "minimal-ui" }])("hides installed controls %j but preserves update notices", async options => {
    const ui = controls({ ...options, production: true });
    await Promise.resolve();
    expect(ui.all().some(node => node.type === "sheet")).toBe(false);
    expect(ui.all().some(node => node.props?.className === "notice update")).toBe(true);
    ui.unmount();
  });
  it("does not count fullscreen as installed and cleans up media and window listeners", () => {
    const ui = controls({ display: "fullscreen" });
    expect(ui.all().some(node => node.type === "sheet")).toBe(true);
    const standalone = ui.media.get("(display-mode: standalone)")!;
    standalone.matches = true;
    standalone.dispatchEvent(new Event("change"));
    expect(ui.all().some(node => node.type === "sheet")).toBe(false);
    standalone.matches = false;
    standalone.dispatchEvent(new Event("change"));
    expect(ui.all().some(node => node.type === "sheet")).toBe(true);
    ui.unmount();
    standalone.matches = true;
    standalone.dispatchEvent(new Event("change"));
    ui.window.dispatchEvent(new Event("appinstalled"));
    expect(ui.all().some(node => node.type === "sheet")).toBe(true);
    ui.window.dispatchEvent(promptEvent("accepted").event);
    expect(ui.installButton()).toBeUndefined();
  });
});
