import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ states: [] as unknown[], effects: [] as (() => void | (() => void))[], cursor: 0, mounting: true }));
const requests = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), config: vi.fn(), status: vi.fn(), subscription: vi.fn() }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (harness.mounting) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
  },
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { if (harness.mounting) harness.effects.push(effect); },
}));
vi.mock("../src/client/api", () => ({ establishSession: requests.session, api: { watches: { list: { query: requests.list } }, push: { config: { query: requests.config }, status: { query: requests.status } } } }));

import { Watches } from "../src/components/Watches";
import { currentForecastResult, WeatherApp } from "../src/components/WeatherApp";
import type { ForecastResult } from "../src/lib/types";
import { market, now } from "./fixtures";

describe("foreground reconciliation", () => {
  let browser: EventTarget;
  let documentEvents: EventTarget;
  let permissionEvents: EventTarget;
  let permission: { permission: NotificationPermission };
  let network: { onLine: boolean };
  let cleanup: (() => void)[];
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  const mount = () => {
    Watches({ result: null, threshold: 0, operator: "above", offline: false, onSelect: () => {}, onOperatorChange: () => {}, onThresholdChange: () => {} });
    cleanup = harness.effects.map(effect => effect()).filter((value): value is () => void => typeof value === "function");
    harness.mounting = false;
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks();
    harness.states = []; harness.effects = []; harness.cursor = 0; harness.mounting = true; cleanup = [];
    browser = new EventTarget(); documentEvents = new EventTarget(); permissionEvents = new EventTarget();
    permission = { permission: "granted" }; network = { onLine: true };
    vi.stubGlobal("window", Object.assign(browser, { isSecureContext: true, PushManager: {}, Notification: permission, setInterval }));
    vi.stubGlobal("document", Object.assign(documentEvents, { visibilityState: "visible" }));
    vi.stubGlobal("Notification", permission);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("navigator", Object.assign(network, { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: requests.subscription } }) }, permissions: { query: async () => permissionEvents } }));
    requests.session.mockResolvedValue(undefined); requests.list.mockResolvedValue([]);
    requests.config.mockResolvedValue({ enabled: true, publicKey: "public" }); requests.status.mockResolvedValue(true);
    requests.subscription.mockResolvedValue({ endpoint: "https://fcm.googleapis.com/fcm/send/token" });
  });
  afterEach(() => { cleanup.forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("keeps Connected after focus and minute refresh only when this endpoint remains registered", async () => {
    mount(); await settle();
    expect(harness.states[10]).toBe("Connected to this installation");
    expect(requests.status).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/fcm/send/token" });
    browser.dispatchEvent(new Event("focus")); await settle();
    expect(harness.states[10]).toBe("Connected to this installation");
    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.states[10]).toBe("Connected to this installation");
    requests.status.mockResolvedValue(false);
    browser.dispatchEvent(new Event("focus")); await settle();
    expect(harness.states[10]).toBe("Browser subscription is not registered; reconnect");
    requests.subscription.mockResolvedValue(null);
    documentEvents.dispatchEvent(new Event("visibilitychange")); await settle();
    expect(harness.states[10]).toBe("Not connected");
    expect(harness.states[12]).toBe(false);
  });

  it("reflects revoked permission offline and recovers without requiring reload", async () => {
    mount(); await settle();
    network.onLine = false; permission.permission = "denied";
    permissionEvents.dispatchEvent(new Event("change")); await settle();
    expect(harness.states[14]).toBe("denied");
    expect(harness.states[10]).toBe("Notification permission not granted");
    network.onLine = true; permission.permission = "granted";
    browser.dispatchEvent(new Event("focus")); await settle();
    expect(harness.states[14]).toBe("granted");
    expect(harness.states[10]).toBe("Connected to this installation");
  });

  it("does not retain Connected if the registration check fails", async () => {
    mount(); await settle();
    requests.status.mockRejectedValue(new Error("Unavailable"));
    browser.dispatchEvent(new Event("focus")); await settle();
    expect(harness.states[10]).toBe("Push registration unavailable");
  });

  it.each(["focus", "online", "visibilitychange"])("updates local forecast time on %s before network refresh completes", async event => {
    const pending = new Promise(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("location", { search: "", href: "https://weather.example.com/" });
    WeatherApp();
    // Only mount the foreground clock/market effect; network reads stay pending.
    const dispose = harness.effects[0]();
    if (typeof dispose === "function") cleanup.push(dispose);
    const result = { market, status: "ready", diagnostics: [], freshUntil: new Date(now + 120000).toISOString(), forecast: { targetAt: market.targetAt } } as unknown as ForecastResult;
    vi.setSystemTime(now + 7200000);
    (event === "visibilitychange" ? documentEvents : browser).dispatchEvent(new Event(event));
    expect(harness.states[14]).toBe(now + 7200000);
    expect(currentForecastResult(result, harness.states[14] as number)?.status).toBe("expired");
  });
  it("hydrates the exact Outlook condition on an independent Watches page", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("location", { search: "?market=123&watch=owned&snapshotId=17&boundary=2000&operator=below", href: "https://weather.example.com/watches?market=123&watch=owned&snapshotId=17&boundary=2000&operator=below" });
    WeatherApp({ mode: "watches" });
    const dispose = harness.effects[0]();
    if (typeof dispose === "function") cleanup.push(dispose);
    expect(harness.states[3]).toBe(123); expect(harness.states[4]).toBe("17");
    expect(harness.states[5]).toBe("below"); expect(harness.states[6]).toBe(2000);
  });
});
