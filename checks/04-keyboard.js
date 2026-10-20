// Keyboard (WCAG 2.1.1, 4.1.2): presses Tab until focus leaves the page and notes each stop.
const stops = [];
for (let i = 0; i < 15; i++) {
  await page.keyboard.press('Tab');
  const stop = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return { tag: el.tagName, role: el.getAttribute('role'), text: (el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 40) };
  });
  if (!stop) break;
  stops.push(stop);
}
return stops;
