// Names and roles (WCAG 1.1.1, 4.1.2): reads the accessibility tree and lists
// images, fields, buttons and links that have no accessible name.
const tree = await page.locator('body').ariaSnapshot();
const unnamed = tree
  .split('\n')
  .map((line) => line.trim().match(/^- (img|textbox|button|link|checkbox|combobox)(?: \[[^\]]*\])?:?$/)?.[1])
  .filter(Boolean);
return { unnamed, tree };
