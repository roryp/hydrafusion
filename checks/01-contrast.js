// Contrast (WCAG 1.4.3): works out the ratio from colors.
// Returns the five text elements with the lowest contrast against their background.
return await page.evaluate(() => {
  const parse = (value) => {
    const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
    return { r, g, b, a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const backgroundOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg.a > 0) return bg;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  const results = [];
  for (const el of document.body.querySelectorAll('*')) {
    const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join(' ').trim();
    if (!text) continue;
    const fg = parse(getComputedStyle(el).color);
    const bg = backgroundOf(el);
    const [light, dark] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    const ratio = Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    results.push({ text: text.slice(0, 60), color: hex(fg), background: hex(bg), ratio });
  }
  return results.sort((a, b) => a.ratio - b.ratio).slice(0, 5);
});
