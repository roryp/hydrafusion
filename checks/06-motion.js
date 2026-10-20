// Motion (WCAG 2.2.2, 2.3.3): turns on reduced motion and lists what still moves.
await page.emulateMedia({ reducedMotion: 'reduce' });
const result = await page.evaluate(() => ({
  prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  stillAnimating: document.getAnimations()
    .filter((animation) => animation.playState === 'running')
    .map((animation) => ({ name: animation.animationName ?? 'animation', text: animation.effect?.target?.textContent?.trim().slice(0, 40) ?? '' })),
}));
await page.emulateMedia({ reducedMotion: null });
return result;
