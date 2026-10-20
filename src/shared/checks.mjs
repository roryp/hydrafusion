// The accessibility checks. Each one is a snippet in checks/, run on the demo page.
// A snippet is the body of an async function with `page` in scope, which is what
// VS Code's Run Playwright Code tool runs, so you can paste one into chat as it is.
// `expected` is what each snippet finds on the demo page, which has these problems built in.

export const CHECKS = [
  {
    id: 'contrast',
    file: '01-contrast.js',
    check: 'Contrast',
    how: 'Works out the ratio from colors',
    expected: '1.14:1, white on light gray',
    describe: (r) => (r?.length ? `${r[0].ratio}:1, ${r[0].color} on ${r[0].background}` : 'No text found'),
    matchesExpected: (r) => r?.[0]?.ratio === 1.14 && r[0].color === '#ffffff' && r[0].background === '#f0f0f0',
  },
  {
    id: 'language-landmarks',
    file: '02-language-landmarks.js',
    check: 'Language, landmarks',
    how: 'Looks for lang and main',
    expected: 'Both are missing',
    describe: (r) => {
      const missing = [!r.lang && 'lang', !r.main && 'main'].filter(Boolean);
      return missing.length === 2 ? 'Both are missing' : missing.length ? `${missing[0]} is missing` : `lang="${r.lang}", main found`;
    },
    matchesExpected: (r) => !r.lang && r.main === 0,
  },
  {
    id: 'heading-order',
    file: '03-heading-order.js',
    check: 'Heading order',
    how: 'Lists the headings in order',
    expected: 'H3, then H1, then H2',
    describe: (r) => r.map((h) => h.level).join(', then '),
    matchesExpected: (r) => r.map((h) => h.level).join(',') === 'H3,H1,H2',
  },
  {
    id: 'keyboard',
    file: '04-keyboard.js',
    check: 'Keyboard',
    how: 'Presses Tab, notes each stop',
    expected: 'Three stops are divs, not buttons',
    describe: (r) => {
      const divs = r.filter((s) => s.tag === 'DIV').length;
      return `${r.map((s) => s.tag).join(', ')}: ${divs} ${divs === 1 ? 'stop is a div' : 'stops are divs'}, not buttons`;
    },
    matchesExpected: (r) => r.filter((s) => s.tag === 'DIV').length === 3
      && r.slice(0, 6).map((s) => s.tag).join(',') === 'A,INPUT,INPUT,INPUT,TEXTAREA,DIV',
  },
  {
    id: 'reflow',
    file: '05-reflow.js',
    check: 'Reflow',
    how: 'Resizes to 320 px wide',
    expected: 'Scrolls sideways, 348 px wide',
    describe: (r) => (r.scrollsSideways ? `Scrolls sideways, ${r.scrollWidth} px wide` : `Fits in ${r.viewportWidth} px`),
    matchesExpected: (r) => r.scrollsSideways && r.scrollWidth === 348,
  },
  {
    id: 'motion',
    file: '06-motion.js',
    check: 'Motion',
    how: 'Turns on reduced motion',
    expected: 'The blinking text keeps going',
    describe: (r) => (r.stillAnimating.length
      ? `Still animating: ${r.stillAnimating.map((a) => `${a.name} ("${a.text}")`).join(', ')}`
      : 'Nothing animates'),
    matchesExpected: (r) => r.prefersReducedMotion && r.stillAnimating.some((a) => a.name === 'blink'),
  },
  {
    id: 'names-roles',
    file: '07-names-roles.js',
    check: 'Names and roles',
    how: 'Reads the accessibility tree',
    expected: 'An image and a field with no name',
    describe: (r) => (r.unnamed.length ? `No name: ${r.unnamed.join(', ')}` : 'Everything has a name'),
    matchesExpected: (r) => r.unnamed.join(',') === 'img,textbox',
  },
  {
    id: 'axe',
    file: '08-axe.js',
    check: 'axe-core',
    how: 'Loads axe and runs it',
    expected: 'Flags contrast, lang, alt, labels',
    describe: (r) => `Flags ${r.map((v) => v.rule).join(', ')}`,
    matchesExpected: (r) => ['color-contrast', 'html-has-lang', 'image-alt', 'label'].every((rule) => r.some((v) => v.rule === rule)),
  },
];
