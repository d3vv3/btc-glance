import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { selectionHref } from "../src/lib/selection";
import { WeatherApp } from "../src/components/WeatherApp";
import manifest from "../src/app/manifest";

describe("independent app routes", () => {
  it("preserves exact public watch selection across page boundaries", () => {
    const href = selectionHref("/watches", "?market=123&watch=owned&snapshotId=17&owner=secret&view=other", { threshold: 2000, operator: "below" });
    expect(href).toBe("/watches?market=123&watch=owned&snapshotId=17&boundary=2000&operator=below");
    expect(selectionHref("/", href.split("?")[1])).toBe("/?market=123&watch=owned&snapshotId=17&boundary=2000&operator=below");
  });
  it("keeps owned watches and history out of Outlook", () => {
    const html = renderToStaticMarkup(createElement(WeatherApp));
    expect(html).not.toContain('id="watches"'); expect(html).not.toContain('id="history"'); expect(html).toContain("Bitcoin weather");
    expect(renderToStaticMarkup(createElement<{ mode?: "outlook" | "watches" }>(WeatherApp, { mode: "watches" }))).toContain('id="watches"');
  });
  it("uses pathname links with page semantics and real manifest shortcuts", () => {
    const navigation = readFileSync(new URL("../src/components/Navigation.tsx", import.meta.url), "utf8");
    expect(navigation).toContain("usePathname"); expect(navigation).toContain('"page"'); expect(navigation).not.toContain('role="tab"');
    expect(manifest().shortcuts?.map(s => s.url)).toEqual(["/", "/watches", "/history"]);
    for (const route of ["watches", "history"]) expect(readFileSync(new URL(`../src/app/${route}/page.tsx`, import.meta.url), "utf8")).toContain("export default");
  });
});
