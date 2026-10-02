import assert from "node:assert/strict";

// The coordinator supplies a Playwright page at the fresh canonical preview.
// Use a fixture with multiple nonzero bands/columns to exercise every arrow.
export async function verifyProjectionHeatmap(page, { touch = false } = {}) {
  const projection = page.locator(".projection");
  await projection.getByRole("button", { name: "Heatmap", exact: true }).click();
  const cells = projection.locator('[data-testid="heatmap-cell"]');
  await cells.first().waitFor({ state: "visible" });
  assert.equal(await projection.locator(".projection-controls").evaluate(node => {
    const cadence = node.querySelector('[aria-label="Market cadence"]').getBoundingClientRect();
    const view = node.querySelector('[aria-label="Projection view"]').getBoundingClientRect();
    const horizon = node.querySelector("select").getBoundingClientRect();
    const toolbar = node.getBoundingClientRect();
    return [cadence, view].every(box => Math.abs(box.y + box.height / 2 - horizon.y - horizon.height / 2) < 1) && cadence.left >= toolbar.left && cadence.right <= view.left && view.right <= horizon.left && horizon.right <= toolbar.right + 1;
  }), true, "cadence, chart views and horizon must fit one row in that order");
  assert.equal(await projection.locator(".projection-guide-halo").count(), 0);
  assert.equal(await projection.locator('[data-testid="guide-segment"]').evaluateAll(nodes => nodes.every(node => node.querySelectorAll("line").length === 1 && node.firstElementChild.getAttribute("data-testid") === "guide-direction")), true);
  assert.equal(await projection.locator('[data-testid="guide-direction"]').evaluateAll(nodes => nodes.every(node => node.getAttribute("stroke-width") === "3" && getComputedStyle(node).pointerEvents === "none" && getComputedStyle(node).filter.startsWith("drop-shadow("))), true);
  assert.equal(await projection.locator('[data-testid="guide-segment"]').count(), await projection.locator('[data-testid="guide-direction"]').count());
  assert.equal(await projection.locator('[data-testid="heatmap-cell"][tabindex="0"]').count(), 1);
  const first = projection.locator('[data-testid="heatmap-cell"][tabindex="0"]');
  await first.scrollIntoViewIfNeeded();
  await first.evaluate(node => node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  assert.equal(await first.evaluate(node => {
    const box = node.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
  }), true, "headers, guide and labels must not intercept cells");
  const share = (await first.getAttribute("aria-label")).split("quote share ")[1];
  if (touch) await first.tap(); else { await first.hover(); await first.click(); }
  await page.waitForFunction(share => document.querySelector(".heatmap-inspection")?.textContent.includes(`${share} quote share`), share);
  await first.focus();
  for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft"]) {
    await page.keyboard.press(key);
    assert.equal(await projection.locator('[data-testid="heatmap-cell"][tabindex="0"]').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "heatmap-cell");
    const focusedShare = await page.evaluate(() => document.activeElement.getAttribute("aria-label").split("quote share ")[1]);
    assert.ok((await projection.locator(".heatmap-inspection").innerText()).includes(`${focusedShare} quote share`));
  }
  await page.keyboard.press("Enter");
  assert.equal(await projection.locator('.forecast-column[aria-pressed="true"]').count(), 1);
  const headers = projection.locator('.forecast-column:not(:disabled)');
  if (await headers.count() > 1) {
    await headers.nth(1).click();
    assert.equal(await headers.nth(1).getAttribute("aria-pressed"), "true");
    assert.ok((await projection.locator(".projection-focus").innerText()).startsWith("$"));
  }
  assert.equal(await projection.locator(".projection-scroll").evaluate(node => getComputedStyle(node).maskImage), "none");
  assert.equal(await cells.evaluateAll(nodes => nodes.every(node => Number(node.getAttribute("fill-opacity")) > 0)), true);
  const plot = await projection.locator(".forecast-range-plot").boundingBox();
  assert.equal(await headers.first().evaluate((node, top) => node.getBoundingClientRect().bottom <= top + 1, plot.y), true);
}

// Range rectangles measure the actual labels, not just the flex-item boxes.
// Also used against same-origin Firefox frames with true narrow layout viewports.
export function measureProjectionToolbar(doc = document) {
  const toolbar = doc.querySelector(".projection-controls");
  const bounds = toolbar.getBoundingClientRect();
  const win = doc.defaultView;
  const groups = [...toolbar.children].map(node => node.getBoundingClientRect());
  const failures = [];
  if (doc.documentElement.scrollWidth > win.innerWidth) failures.push("page overflow");
  groups.forEach((box, i) => {
    if (box.left < bounds.left - .5 || box.right > bounds.right + .5) failures.push("group outside toolbar");
    if (i && box.left < groups[i - 1].right + (win.innerWidth <= 340 ? 3.5 : 5.5)) failures.push("groups overlap or lose gap");
    if (Math.abs(box.top + box.height / 2 - groups[0].top - groups[0].height / 2) > .5) failures.push("different rows");
  });
  const buttons = [...toolbar.querySelectorAll("button")].map(button => {
    const box = button.getBoundingClientRect();
    const group = button.parentElement.getBoundingClientRect();
    const style = win.getComputedStyle(button);
    const walker = doc.createTreeWalker(button, win.NodeFilter.SHOW_TEXT);
    const textRects = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(walker.currentNode);
      textRects.push(...range.getClientRects());
    }
    const icons = [...button.querySelectorAll("svg")].filter(icon => win.getComputedStyle(icon).display !== "none").map(icon => icon.getBoundingClientRect());
    const content = [...textRects, ...icons];
    const leftPadding = Math.min(...content.map(rect => rect.left)) - box.left - parseFloat(style.borderLeftWidth);
    const rightPadding = box.right - parseFloat(style.borderRightWidth) - Math.max(...content.map(rect => rect.right));
    if (leftPadding < 4 || rightPadding < 4) failures.push(`${button.textContent}: insufficient content padding`);
    if (content.some(rect => rect.top < box.top || rect.bottom > box.bottom)) failures.push(`${button.textContent}: vertical overflow`);
    if (box.left < group.left || box.right > group.right) failures.push(`${button.textContent}: outside segment`);
    if (button.previousElementSibling && box.left < button.previousElementSibling.getBoundingClientRect().right) failures.push(`${button.textContent}: overlapping buttons`);
    if (icons.some(icon => textRects.some(text => icon.right > text.left - 3.5))) failures.push(`${button.textContent}: icon/label overlap`);
    if (box.height < 44 || parseFloat(style.fontSize) < 12 || parseFloat(style.letterSpacing) < 0 || style.overflowX === "hidden" || style.textOverflow === "ellipsis") failures.push(`${button.textContent}: clipped or undersized`);
    return { label: button.textContent, width: box.width, leftPadding, rightPadding, iconWidth: icons[0]?.width ?? 0 };
  });
  return { width: win.innerWidth, theme: doc.documentElement.dataset.theme, toolbarWidth: bounds.width, buttons, failures };
}

export async function verifyProjectionToolbar(page) {
  for (const width of [320, 360, 390, 500, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.getByRole("switch", { name: "Dark theme" }).click();
      const result = await page.evaluate(measureProjectionToolbar);
      assert.equal(result.width, width, "browser must use the requested layout viewport");
      assert.deepEqual(result.failures, [], `${width}px ${theme}: ${JSON.stringify(result)}`);
    }
  }
}

// Run after integration on a fresh preview. A dedicated context isolates storage.
export async function verifyThemes(page, { screenshotDirectory } = {}) {
  const errors = [];
  const capture = message => { if (/hydration|didn't match|did not match/i.test(message.text())) errors.push(message.text()); };
  page.on("console", capture);
  await page.evaluate(() => localStorage.removeItem("bw-theme"));
  for (const system of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: system });
    await page.reload();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, system);
    const toggle = page.getByRole("switch", { name: "Dark theme" });
    await page.waitForFunction(dark => document.querySelector('.theme-switch')?.getAttribute('aria-checked') === String(dark), system === "dark");
    assert.equal(await toggle.getAttribute("title"), system === "dark" ? "Use light theme" : "Use dark theme");
  }
  await page.getByRole("switch", { name: "Dark theme" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: width > 799 ? 900 : 844 });
    for (const theme of ["light", "dark"]) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await page.getByRole("switch", { name: "Dark theme" }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "shell must fit viewport");
      const state = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, meta: [...document.querySelectorAll('meta[name="theme-color"]')].map(meta => meta.content) }));
      assert.equal(state.background, theme === "light" ? "rgb(242, 244, 243)" : "rgb(24, 32, 36)");
      assert.ok(state.meta.every(value => value === (theme === "light" ? "#f2f4f3" : "#182024")));
      if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/theme-${theme}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  page.off("console", capture);
}

export async function verifyBlockedThemeStorage(page) {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  const errors = [];
  const capture = message => { if (/hydration|didn't match|did not match/i.test(message.text())) errors.push(message.text()); };
  page.on("console", capture);
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  const toggle = page.getByRole("switch", { name: "Dark theme" });
  await page.waitForFunction(() => document.querySelector('.theme-switch')?.getAttribute('aria-checked') === "false");
  await toggle.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark" && document.querySelector('.theme-switch')?.getAttribute('aria-checked') === "true");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "blocked storage must not cancel the in-memory manual choice");
  assert.equal(await toggle.getAttribute("title"), "Use light theme");
  await toggle.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.deepEqual(errors, []);
  page.off("console", capture);
}
