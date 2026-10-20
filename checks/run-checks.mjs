// npm run checks: runs every accessibility snippet against the demo page and compares
// each result with the problem the page has built in. The dashboard's "Run the checks" button uses runChecks().

import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isMain } from '../src/paths.mjs';
import { CHECKS } from '../src/shared/checks.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Uses an installed Chrome or Edge, so no browser download is needed.
// Set HF_BROWSER=chromium to use Playwright's own build (after "npx playwright install chromium").
export async function launchBrowser() {
  const channels = [...new Set([process.env.HF_BROWSER || 'chrome', 'chrome', 'msedge', 'chromium'])];
  let lastError;
  for (const channel of channels) {
    try {
      return await chromium.launch(channel === 'chromium' ? {} : { channel });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Couldn't start a browser. Install Chrome or Edge, or run "npx playwright install chromium". ${lastError?.message ?? ''}`);
}

export async function runChecks({ baseUrl }) {
  const pageUrl = new URL('/demo-page/', baseUrl).href;
  const browser = await launchBrowser();
  try {
    const results = [];
    for (const check of CHECKS) {
      // A fresh page for each snippet, so focus, viewport and media settings don't leak between checks.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      try {
        await page.goto(pageUrl);
        const code = await readFile(new URL(check.file, import.meta.url), 'utf8');
        const value = await new AsyncFunction('page', code)(page);
        results.push({ id: check.id, check: check.check, expected: check.expected, measured: check.describe(value), matchesExpected: !!check.matchesExpected(value), value });
      } catch (err) {
        results.push({ id: check.id, check: check.check, expected: check.expected, measured: null, matchesExpected: false, error: err.message });
      } finally {
        await context.close();
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  const { startServer } = await import('../src/server.mjs');
  const server = await startServer({ port: 0 });
  try {
    const results = await runChecks({ baseUrl: server.origin });
    const width = Math.max(...results.map((r) => r.check.length));
    console.log(`Checks on ${server.pageUrl}\n`);
    for (const r of results) {
      const mark = r.matchesExpected ? '✔' : '✖';
      console.log(`${mark} ${r.check.padEnd(width)}  ${r.error ? `error: ${r.error}` : r.measured}`);
      if (!r.matchesExpected) console.log(`  ${''.padEnd(width)}  expected: ${r.expected}`);
    }
    const mismatches = results.filter((r) => !r.matchesExpected).length;
    console.log(mismatches ? `\n${mismatches} check(s) didn't find the expected problem.` : '\nEvery check found the problem the demo page has built in.');
    process.exitCode = mismatches ? 1 : 0;
  } finally {
    await server.close();
  }
}
