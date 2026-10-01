import { afterEach, expect, it, vi } from "vitest";
import { activePushRegistration } from "../src/lib/push-readiness";
import manifest from "../src/app/manifest";

afterEach(() => vi.useRealTimers());

it("keeps a stable identity and navigation shortcuts", () => {
  expect(manifest()).toMatchObject({ id: "/", start_url: "/", scope: "/", shortcuts: [
    { name: "Outlook", url: "/" }, { name: "Watches", url: "/watches" }, { name: "History", url: "/history" },
  ] });
});
it("uses an active registration without waiting for ready", async () => {
  const registration = { active: {} };
  const container = { getRegistration: vi.fn(async () => registration), get ready() { throw new Error("Must not wait"); } };
  expect(await activePushRegistration(container as unknown as ServiceWorkerContainer)).toBe(registration);
});
it("waits for first activation instead of requiring a reload", async () => {
  let activate!: (registration: any) => void;
  const ready = new Promise<ServiceWorkerRegistration>(resolve => { activate = resolve; });
  const container = { getRegistration: vi.fn(async () => ({ active: null })), ready };
  const request = activePushRegistration(container as unknown as ServiceWorkerContainer);
  const registration = { active: {} };
  activate(registration);
  expect(await request).toBe(registration);
});
it("bounds missing readiness and permits a subsequent retry", async () => {
  vi.useFakeTimers();
  const container = { getRegistration: vi.fn(async (): Promise<any> => undefined), ready: new Promise(() => {}) };
  const request = activePushRegistration(container as unknown as ServiceWorkerContainer, 100);
  const assertion = expect(request).rejects.toThrow("Try connecting again shortly");
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
  container.getRegistration.mockResolvedValueOnce({ active: {} });
  await expect(activePushRegistration(container as unknown as ServiceWorkerContainer)).resolves.toHaveProperty("active");
  expect(vi.getTimerCount()).toBe(0);
});
