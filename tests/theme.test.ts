import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { themeBootstrap, observeTheme, themeColors, type Theme } from "../src/lib/theme";
import { ThemeSwitch } from "../src/components/ThemeSwitch";

afterEach(() => vi.unstubAllGlobals());
function environment(dark: boolean, stored?: string, blocked = false) {
  const root = { dataset: {} as Record<string, string> };
  const metas = [{ content: "" }, { content: "" }];
  const listeners = new Map<string, () => void>();
  const media = { matches: dark, addEventListener: vi.fn((name, callback) => listeners.set(name, callback)), removeEventListener: vi.fn() };
  const localStorage = { getItem: () => { if (blocked) throw Error("Blocked"); return stored ?? null; }, setItem: vi.fn((_key: string, value: string) => { if (blocked) throw Error("Blocked"); stored = value; }) };
  const document = { documentElement: root, querySelectorAll: () => metas };
  const window = { matchMedia: () => media, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return { root, metas, media, localStorage, document, window, matchMedia: window.matchMedia, listeners };
}
describe("theme preference", () => {
  it("emphasizes only distribution selection with theme-aware yellow and keeps line samples compact", () => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    const light = styles.match(/:root, :root\[data-theme=light\] \{([^}]+)\}/)![1];
    const dark = styles.match(/:root\[data-theme=dark\] \{([^}]+)\}/)![1];
    expect(light).toContain("--selection: rgba(245, 200, 66, .35)");
    expect(dark).toContain("--selection: rgba(255, 188, 72, .28)");
    for (const theme of [light, dark]) expect(theme).toMatch(/--selection-bar: rgba\([^;]+, \.65\)/);
    expect(styles).toContain(".selection-band { fill: var(--selection); }");
    expect(styles).toContain(".bar.included:not(.modal) .column { fill: var(--selection-bar); }");
    expect(styles).toContain(".bar.modal .column { fill: var(--chart-primary); }");
    expect(styles).toContain(".projection-line-legend i { width: 28px; height: 3px; border-top: 3px solid var(--ink); }");
    expect(styles).toContain("border-top-color: var(--primary); border-top-style: dashed;");
  });
  it.each([[false, undefined, "light"], [true, undefined, "dark"], [true, "light", "light"], [false, "dark", "dark"], [false, "invalid", "light"]] as const)("bootstraps system %s with storage %s before paint", (dark, stored, expected) => {
    const env = environment(dark, stored);
    runInNewContext(themeBootstrap, env);
    expect(env.root.dataset.theme).toBe(expected);
    expect(env.metas.every(meta => meta.content === themeColors[expected])).toBe(true);
  });
  it("bootstraps safely with blocked storage", () => {
    const env = environment(true, undefined, true);
    expect(() => runInNewContext(themeBootstrap, env)).not.toThrow();
    expect(env.root.dataset.theme).toBe("dark");
  });
  it.each([false, true])("follows system until manual selection, with blocked storage %s", blocked => {
    const env = environment(false, undefined, blocked);
    for (const name of ["window", "document", "localStorage"] as const) vi.stubGlobal(name, env[name]);
    const states: Theme[] = [];
    const controller = observeTheme(theme => states.push(theme));
    env.media.matches = true; env.listeners.get("change")!();
    controller.choose("light");
    env.listeners.get("change")!();
    expect(states).toEqual(["light", "dark", "light", "light"]);
    expect(env.metas[0].content).toBe(themeColors.light);
    expect(env.localStorage.setItem).toHaveBeenCalledWith("bw-theme", "light");
    controller.dispose();
    expect(env.media.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
  it("has deterministic server markup and only suppresses the intentional root attribute", () => {
    expect(renderToStaticMarkup(createElement(ThemeSwitch))).toContain('role="switch" aria-label="Dark theme" aria-checked="false"');
    const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toContain('<html lang="en" suppressHydrationWarning>');
    expect(layout).toContain("__html: themeBootstrap");
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    for (const token of ["positive", "negative", "weight-plate", "background", "guide-shadow", "field", "stale"]) expect(styles).toContain(`--${token}:`);
    expect(styles).toContain("transparent, var(--background) 75%");
  });
  it("restores a manual selection when the cached shell bootstraps again", () => {
    const env = environment(true);
    for (const name of ["window", "document", "localStorage"] as const) vi.stubGlobal(name, env[name]);
    const controller = observeTheme(() => {});
    controller.choose("light"); controller.dispose();
    env.root.dataset.theme = "dark";
    runInNewContext(themeBootstrap, env);
    expect(env.root.dataset.theme).toBe("light");
  });
});
