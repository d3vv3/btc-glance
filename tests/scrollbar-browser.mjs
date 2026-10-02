import assert from "node:assert/strict";

// The coordinator supplies a fresh preview page with enough content to scroll.
export async function verifyPageScrollbar(page) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 500 });
    const state = await page.evaluate(() => ({
      styles: [document.documentElement, document.body].map(node => {
        const style = getComputedStyle(node);
        return { scrollbarWidth: style.scrollbarWidth, overflowY: style.overflowY, touchAction: style.touchAction };
      }),
      scrollable: document.scrollingElement.scrollHeight > window.innerHeight,
    }));
    assert.equal(state.scrollable, true, "fixture must provide a vertically scrollable page");
    for (const style of state.styles) {
      assert.equal(style.scrollbarWidth, "none");
      assert.ok(!["hidden", "clip"].includes(style.overflowY));
      assert.notEqual(style.touchAction, "none");
    }
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => window.scrollY > 0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.mouse.move(width / 2, 250);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => window.scrollY > 0);
  }
}
