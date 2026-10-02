import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { activePushRegistration } from "../src/lib/push-readiness";

// Mock browser permission and push APIs; this does not exercise a native permission dialog.
async function watchesUi(initialPermission: NotificationPermission = "default", registered = false, result: any = null) {
  const slots: any[] = [];
  let index = 0;
  let mounted = false;
  const effects: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const notification = { permission: initialPermission, requestPermission: vi.fn<() => Promise<NotificationPermission>>() };
  const subscription = { toJSON: () => ({ endpoint: "https://push.example/sub", keys: { auth: "auth", p256dh: "key" } }) };
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) } };
  const serviceWorker = { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) };
  const establishSession = vi.fn(async () => {});
  const register = vi.fn(async () => {});
  const config = vi.fn(async () => ({ enabled: true, publicKey: "AQID" }));
  const api = { watches: { list: { query: vi.fn(async () => []) }, create: { mutate: vi.fn(async () => {}) } }, push: { config: { query: config }, status: { query: vi.fn(async () => registered) }, register: { mutate: register } } };
  if (registered) registration.pushManager.getSubscription.mockResolvedValue(subscription as any);
  const react = {
    useState: (initial: any) => { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], (value: any) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }]; },
    useRef: (initial: any) => { const slot = index++; return slots[slot] ??= { current: initial }; },
    useEffect: (effect: () => void) => { if (!mounted) effects.push(effect); },
  };
  const jsx = (type: any, props: any) => typeof type === "function" ? type(props) : ({ type, props });
  const exports: { Watches?: (props: any) => any } = {};
  const window = Object.assign(new EventTarget(), { isSecureContext: true, Notification: notification, PushManager: {} });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  runInNewContext(ts.transpileModule(readFileSync(new URL("../src/components/Watches.tsx", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, window, document, Notification: notification, navigator: { onLine: true, serviceWorker }, location: { search: "" }, URLSearchParams, atob, requestAnimationFrame: (callback: () => void) => callback(), setInterval: (callback: () => void) => { timers.push(callback); return timers.length; }, clearInterval: () => {},
    require: (name: string) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name.includes("client/api") ? { api, establishSession } : name.includes("push-readiness") ? { activePushRegistration } : name === "./Histogram" ? { money: String, percent: String } : {},
  });
  const onSelect = vi.fn();
  const render = () => { index = 0; return exports.Watches!({ result, threshold: 86000, operator: "below", offline: false, onSelect, onOperatorChange: vi.fn(), onThresholdChange: vi.fn() }); };
  const nodes = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  render(); effects.forEach(effect => effect()); mounted = true;
  await flush();
  const all = () => nodes(render());
  const connect = () => all().find(node => node.type === "button" && node.props.className === "primary" && Array.isArray(node.props.children) && node.props.children.some((child: any) => child === "Enable" || child === "Connecting..."));
  return { all, connect, notification, serviceWorker, registration, establishSession, register, config, window, slots, api, timers, onSelect };
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
  expect(ui.connect().props.disabled).toBe(true);
  ui.notification.permission = "granted"; finish("granted");
  await flush();
  expect(ui.register).toHaveBeenCalledOnce();
  expect(ui.slots[20]).toBe(false);
});

it.each(["default", "denied"] as const)("does not subscribe after %s and explains recovery", async permission => {
  const ui = await watchesUi();
  ui.notification.requestPermission.mockImplementation(async () => { ui.notification.permission = permission; return permission; });
  ui.connect().props.onClick(); await flush();
  expect(ui.registration.pushManager.subscribe).not.toHaveBeenCalled();
  expect(ui.register).not.toHaveBeenCalled();
  expect(ui.slots[20]).toBe(permission === "denied");
  if (permission === "denied") expect(ui.connect()).toBeUndefined();
  if (permission === "denied") { ui.notification.permission = "granted"; ui.window.dispatchEvent(new Event("focus")); await flush(); }
  ui.notification.requestPermission.mockResolvedValue("granted");
  ui.connect().props.onClick(); await flush();
  expect(ui.register).toHaveBeenCalledOnce();
});

it.each(["default", "denied", "granted"] as const)("offers notifications once on arrival (%s), never requesting permission on polling", async permission => {
  const ui = await watchesUi(permission);
  expect(ui.slots[20]).toBe(true);
  expect(ui.notification.requestPermission).not.toHaveBeenCalled();
  ui.all().find(node => node.type === "button" && node.props.children === "Later")!.props.onClick();
  ui.window.dispatchEvent(new Event("focus")); await flush();
  ui.timers.forEach(timer => timer()); await flush();
  expect(ui.slots[20]).toBe(false);
  expect(ui.notification.requestPermission).not.toHaveBeenCalled();
});

it("does not offer notifications when already connected, and reconnects granted permission without requesting it again", async () => {
  const connected = await watchesUi("granted", true);
  expect(connected.slots[20]).toBe(false);
  expect(connected.notification.requestPermission).not.toHaveBeenCalled();
  const unregistered = await watchesUi("granted");
  unregistered.connect().props.onClick(); await flush();
  expect(unregistered.register).toHaveBeenCalledOnce();
  expect(unregistered.notification.requestPermission).not.toHaveBeenCalled();
});

it("opens New watch only on click and Cancel closes it without changing saved watches", async () => {
  const ui = await watchesUi();
  expect(ui.all().some(node => node.type === "form")).toBe(false);
  ui.all().find(node => node.type === "button" && node.props["aria-label"] === "New watch")!.props.onClick();
  expect(ui.all().some(node => node.type === "form")).toBe(true);
  expect(ui.all().some(node => node.props["aria-label"] === "New watch")).toBe(false);
  ui.all().find(node => node.type === "button" && node.props.children === "Cancel")!.props.onClick();
  expect(ui.all().some(node => node.type === "form")).toBe(false);
  expect(ui.all().some(node => node.props["aria-label"] === "New watch")).toBe(true);
  expect(ui.slots[4]).toBeNull();
});

it("creates a Below watch while notifications are denied and closes only after mutation succeeds", async () => {
  const ui = await watchesUi("denied", false, { status: "ready", market: { topicId: 456 }, freshUntil: "2099-01-01T00:00:00Z", forecast: { source: "live", targetAt: "2099-01-01T00:00:00Z", buckets: [{ lower: 85000, upper: 86000, probability: .4 }, { lower: 86000, upper: 87000, probability: .6 }] } });
  ui.all().find(node => node.type === "button" && node.props.children === "Later")!.props.onClick();
  ui.all().find(node => node.type === "button" && node.props["aria-label"] === "New watch")!.props.onClick();
  expect(ui.all().find(node => node.type === "button" && node.props.type === "submit")!.props.disabled).toBe(false);
  let resolve!: () => void;
  ui.api.watches.create.mutate.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes; }));
  ui.all().find(node => node.type === "form")!.props.onSubmit({ preventDefault: () => {} }); await flush();
  expect(ui.api.watches.create.mutate).toHaveBeenCalledWith({ topicId: 456, operator: "below", threshold: 86000, materialPp: 5, cooldownSeconds: 3600, enabled: true });
  expect(ui.all().some(node => node.type === "form")).toBe(true);
  resolve(); await flush();
  expect(ui.all().some(node => node.type === "form")).toBe(false);
  expect(ui.notification.requestPermission).not.toHaveBeenCalled();
  expect(ui.slots[20]).toBe(false);
});

it("restores the exact saved condition and nonstandard cooldown for Edit, and Cancel resets without deletion", async () => {
  const ui = await watchesUi();
  const saved = { id: "owned", topicId: 456, threshold: 86400, operator: "below", materialPp: 3, cooldownSeconds: 1200, enabled: true };
  ui.slots[0] = [saved];
  ui.all().find(node => node.props["aria-label"] === "Edit watch")!.props.onClick();
  expect(ui.onSelect).toHaveBeenCalledWith(456, 86400, "below");
  expect(ui.slots[6]).toBe(1200);
  expect(ui.all().filter(node => node.type === "option").map(node => node.props.value)).toContain(1200);
  expect(ui.all().find(node => node.type === "select" && node.props["aria-label"] === "Watch boundary")!.props.value).toBe(86400);
  expect(ui.all().find(node => node.props.type === "submit")!.props.disabled).toBe(true);
  // The form checkbox, not the list toggle, allows disabling without fresh evidence.
  const form = ui.all().find(node => node.type === "form")!;
  const children = (node: any): any[] => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(children) : [node, ...children(node.props?.children)];
  children(form).find(node => node.type === "input" && node.props.type === "checkbox")!.props.onChange({ target: { checked: false } });
  expect(ui.all().find(node => node.props.type === "submit")!.props.disabled).toBe(false);
  ui.all().find(node => node.type === "button" && node.props.children === "Cancel")!.props.onClick();
  expect(ui.slots[0]).toEqual([saved]);
  expect(ui.slots[4]).toBeNull();
  expect(ui.slots[6]).toBe(3600);
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

it("persists list switch changes without fresh evidence and retains the disabled edit snapshot", async () => {
  const ui = await watchesUi();
  const saved = { id: "temporary", topicId: 456, threshold: 86000, operator: "below", materialPp: 5, cooldownSeconds: 3600, enabled: true };
  const update = vi.fn(async (input: typeof saved) => { ui.api.watches.list.query.mockResolvedValue([{ ...input }] as never); });
  Object.assign(ui.api.watches, { update: { mutate: update } });
  ui.slots[0] = [saved];
  const toggle = () => ui.all().find(node => node.props.role === "switch" && node.props["aria-label"].includes("below"))!;
  expect(toggle().props.checked).toBe(true);
  toggle().props.onChange({ target: { checked: false } });
  expect(toggle().props.disabled).toBe(true);
  await flush();
  expect(update).toHaveBeenCalledWith({ ...saved, enabled: false });
  expect(toggle().props.checked).toBe(false);
  ui.all().find(node => node.props["aria-label"] === "Edit watch")!.props.onClick();
  expect(ui.all().find(node => node.props.role === "switch" && node.props["aria-label"] === "Enable watch")!.props.checked).toBe(false);
});
