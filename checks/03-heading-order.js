// Heading order (WCAG 1.3.1, 2.4.6): lists the headings in the order they appear.
return await page.evaluate(() =>
  [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({ level: h.tagName, text: h.textContent.trim() })));
