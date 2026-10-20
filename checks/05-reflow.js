// Reflow (WCAG 1.4.10): resizes to 320 px wide and checks for sideways scrolling.
const original = page.viewportSize();
await page.setViewportSize({ width: 320, height: 640 });
const result = await page.evaluate(() => ({
  viewportWidth: window.innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  scrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
}));
if (original) await page.setViewportSize(original);
return result;
