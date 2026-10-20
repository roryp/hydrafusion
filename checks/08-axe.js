// axe-core: loads axe into the page and runs its WCAG 2.x A and AA rules.
// This project's server hosts axe at /vendor/axe.min.js. On another site, load it from a CDN instead.
if (!(await page.evaluate(() => 'axe' in window))) {
  await page.addScriptTag({ url: new URL('/vendor/axe.min.js', page.url()).href });
}
return await page.evaluate(async () => {
  const { violations } = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  });
  return violations.map((v) => ({ rule: v.id, impact: v.impact, elements: v.nodes.length, help: v.help }));
});
