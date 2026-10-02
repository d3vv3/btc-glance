import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("page scrollbar presentation", () => {
  it("hides the page scrollbar without locking native scrolling or changing nested scroll panes", () => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toMatch(/html, body\s*\{\s*scrollbar-width:\s*none;\s*\}/);
    expect(styles).toMatch(/html::-webkit-scrollbar, body::-webkit-scrollbar\s*\{\s*display:\s*none;\s*width:\s*0;\s*height:\s*0;\s*\}/);
    const pageRules = [...styles.matchAll(/(?:^|\n)(?:html|body)(?:,\s*(?:html|body))?\s*\{([^{}]*)\}/g)];
    expect(pageRules.length).toBeGreaterThan(0);
    for (const rule of pageRules) {
      expect(rule[1]).not.toMatch(/overflow(?:-[xy])?:\s*(?:hidden|clip)|touch-action:\s*none|position:\s*fixed/);
    }
    expect(styles).toContain(".projection-scroll { overflow-x: auto;");
    expect(styles).not.toMatch(/(?:\*|\.sheet(?:-content)?)\s*\{[^{}]*scrollbar-width:\s*none/);
  });
});
