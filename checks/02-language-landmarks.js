// Language and landmarks (WCAG 3.1.1, 1.3.1): looks for lang and main.
return await page.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  main: document.querySelectorAll('main, [role="main"]').length,
  landmarks: [...document.querySelectorAll('header, nav, main, aside, footer, [role]')]
    .map((el) => el.getAttribute('role') ?? el.tagName.toLowerCase()),
}));
