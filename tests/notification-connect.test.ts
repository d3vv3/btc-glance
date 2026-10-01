import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { activePushRegistration } from "../src/lib/push-readiness";

// Mock browser permission and push APIs; this does not exercise a native permission dialog.
async function watchesUi() {
  const slots: any[] = [];
  let index = 0;
  let mounted = false;
  const effects: (() => void)[] = [];
  const notification = { permission: "default", requestPermission: vi.fn<() => Promise<NotificationPermission>>() };
  const subscription = { toJSON: () => ({ endpoint: "https://push.example/sub", keys: { auth: "auth", p256dh: "key" } }) };
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) } };
  const serviceWorker = { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) };
  const establishSession = vi.fn(async () => {});
  const register = vi.fn(async () => {});
  const config = vi.fn(async () => ({ enabled: true, publicKey: "AQID" }));
  const api = { watches: { list: { query: vi.fn(async () => []) } }, push: { config: { query: config }, register: { mutate: register } } };
  const react = {
    useState: (initial: any) => { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], (value: any) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }]; },
    useRef: (initial: any) => { const slot = index++; return slots[slot] ??= { current: initial }; },
    useEffect: (effect: () => void) => { if (!mounted) effects.push(effect); },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: { Watches?: (props: any) => any } = {};
  const window = Object.assign(new EventTarget(), { isSecureContext: true, Notification: notification, PushManager: {} });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/components/Watches.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, window, document, Notification: notification, navigator: { onLine: true, serviceWorker }, location: { search: "" }, URLSearchParams, atob, setInterval: () => 1, clearInterval: () => {},
    require: (name: string) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name.includes("client/api") ? { api, establishSession } : name.includes("push-readiness") ? { activePushRegistration } : name === "./Histogram" ? { money: String, percent: String } : {},
  });
  const render = () => { index = 0; return exports.Watches!({ result: null, threshold: 0, operator: "above", offline: false, onSelect: vi.fn() }); };
  const nodes = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  render(); effects.forEach(effect => effect()); mounted = true;
  await flush();
  const all = () => nodes(render());
  const connect = () => all().find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.some((child: any) => child === "Connect" || child === "Connecting..."));
  return { all, connect, notification, serviceWorker, registration, establishSession, register, config, window };
}
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

it("locks before permission awaits, calls permission synchronously, and ignores double clicks", async () => {
  const ui = await watchesUi();
  let finish!: (permission: NotificationPermission) => void;
  ui.notification.requestPermission.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  ui.establishSession.mockClear(); ui.config.mockClear();
  const button = ui.connect();
  button.props.onClick(); button.props.onClick();
  expect(ui.notification.requestPermission).toHaveBeenCalledOnce();
  expect(ui.establishSession).not.toHaveBeenCalled();
  expect(ui.config).not.toHaveBeenCalled();
  expect(ui.connect().props.disabled).toBe(true);
  ui.window.dispatchEvent(new Event("focus"));
  expect(ui.all().some(node => node.props?.children === "Waiting for notification permission")).toBe(true);
  ui.notification.permission = "granted"; finish("granted");
  await flush();
  expect(ui.register).toHaveBeenCalledOnce();
  expect(ui.connect().props.disabled).toBe(false);
});

it.each(["default", "denied"] as const)("does not subscribe after %s and explains recovery", async permission => {
  const ui = await watchesUi();
  ui.notification.requestPermission.mockImplementation(async () => { ui.notification.permission = permission; return permission; });
  ui.connect().props.onClick(); await flush();
  expect(ui.registration.pushManager.subscribe).not.toHaveBeenCalled();
  expect(ui.register).not.toHaveBeenCalled();
  expect(ui.connect().props.disabled).toBe(permission === "denied");
  expect(ui.all().some(node => typeof node.props?.children === "string" && node.props.children.includes(permission === "denied" ? "browser settings" : "Select Connect to try again"))).toBe(true);
  if (permission === "denied") { ui.notification.permission = "granted"; ui.window.dispatchEvent(new Event("focus")); await flush(); }
  ui.notification.requestPermission.mockResolvedValue("granted");
  ui.connect().props.onClick(); await flush();
  expect(ui.register).toHaveBeenCalledOnce();
});

it("unlocks after permission API failure and can reconnect", async () => {
  const ui = await watchesUi();
  ui.notification.requestPermission.mockRejectedValueOnce(new Error("Permission failed"));
  ui.connect().props.onClick(); await flush();
  expect(ui.connect().props.disabled).toBe(false);
  expect(ui.register).not.toHaveBeenCalled();
  ui.notification.permission = "granted";
  ui.connect().props.onClick(); await flush();
  expect(ui.register).toHaveBeenCalledOnce();
});
