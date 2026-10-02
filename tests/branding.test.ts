import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/app/manifest";
import { AppShell } from "../src/components/AppShell";

vi.mock("../src/components/Navigation", () => ({ Navigation: () => null }));
vi.mock("../src/components/PwaControls", () => ({ PwaControls: () => null }));
vi.mock("../src/components/ThemeSwitch", () => ({ ThemeSwitch: () => null }));

describe("BTC glance branding and installation continuity", () => {
  it("names browser and Apple metadata with exact casing", () => {
    const exports: { metadata?: Record<string, unknown> } = {};
    const source = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: () => ({}) });
    expect(exports.metadata).toMatchObject({
      title: "BTC glance | A market outlook",
      description: "BTC glance: Bitcoin price outlooks from prediction-market quote shares. Explore the distribution, not a promise.",
      applicationName: "BTC glance",
      appleWebApp: { capable: true, title: "BTC glance" },
    });
  });

  it("renames installed labels without changing the existing app identity or launch paths", () => {
    expect(manifest()).toMatchObject({
      name: "BTC glance", short_name: "BTC glance",
      description: "BTC glance: A Bitcoin market outlook, with price distributions and personal watches.",
      id: "/", start_url: "/", scope: "/", display: "standalone",
    });
  });

  it("renders the new header name alongside the unchanged decorative orb", () => {
    const html = renderToStaticMarkup(createElement(AppShell, { children: null }));
    expect(html).toContain("BTC <strong>glance</strong>");
    expect(html).toContain('src="/icons/sun-orb-brand-192.png?v=sun-orb-3"');
    expect(html).toContain('alt=""');
    expect(html).not.toMatch(/Bitcoin Weather|BTC Weather/);
  });
});
