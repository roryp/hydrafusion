import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser } from '../checks/run-checks.mjs';
import { startServer } from '../src/server.mjs';
import { CHECKS } from '../src/shared/checks.mjs';
import { heldRuns } from './helpers.mjs';

test('five dashboard users stay independent, including reload, overload and cancellation', { timeout: 60_000 }, async (t) => {
  const runner = heldRuns();
  const server = await startServer({ port: 0, auth: { enabled: true }, runLive: runner.runLive, save: async () => {} });
  t.after(() => server.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const errors = [];
  const pages = await Promise.all(Array.from({ length: 6 }, async () => {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(server.origin);
    return page;
  }));
  const start = async (page) => {
    const response = page.waitForResponse((res) => res.url().endsWith('/api/live') && res.request().method() === 'POST');
    await page.locator('[data-demo="cascade"] [data-action="live"]').click();
    return response;
  };
  const responses = await Promise.all(pages.slice(0, 5).map(start));
  assert.ok(responses.every((res) => res.status() === 202));
  const runs = await Promise.all(responses.map(async (res) => (await res.json()).run));
  assert.equal(new Set(runs.map((run) => run.id)).size, 5);

  await pages[5].reload();
  assert.equal(await pages[5].getByRole('button', { name: 'Stop the run', exact: true }).count(), 0);
  assert.equal((await start(pages[5])).status(), 409);
  await pages[5].waitForFunction(() => document.querySelector('#live-note').textContent.includes('slots are busy'));
  assert.equal(await pages[5].getByRole('button', { name: 'Stop the run', exact: true }).count(), 0);

  const resumed = pages[0].waitForRequest((req) => req.url().includes(`/api/live/${runs[0].id}?after=0`));
  await pages[0].reload();
  await resumed;
  for (let i = 0; i < 5; i++) {
    const stored = await pages[i].evaluate(() => JSON.parse(sessionStorage.getItem('hydrafusion.live-run')));
    assert.equal(stored.id, runs[i].id);
  }
  await pages[0].getByRole('button', { name: 'Stop the run', exact: true }).click();
  await pages[0].waitForFunction(() => document.querySelector('#viewer [data-role="badge"]').textContent === 'Ended with an error');
  assert.equal(runner.runs.filter((run) => run.signal.aborted).length, 1);
  assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 4);

  await pages[1].locator('[data-demo="single"] [data-action="reference"]').click();
  await pages[1].getByRole('button', { name: 'Back to the live run (still running)', exact: true }).click();
  for (const run of runner.runs) run.finish();
  await Promise.all(pages.slice(1, 5).map((page) => page.waitForFunction(() =>
    document.querySelector('#viewer [data-role="badge"]').textContent === 'Finished'
    && !document.querySelector('[data-demo="cascade"] [data-action="live"]').disabled)));
  assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 0);
  assert.deepEqual(errors, []);
});

test('a slow start disables repeat submissions before the first response arrives', { timeout: 30_000 }, async (t) => {
  const runner = heldRuns();
  const server = await startServer({ port: 0, auth: { enabled: true }, runLive: runner.runLive, save: async () => {} });
  t.after(() => server.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const held = Promise.withResolvers();
  const intercepted = Promise.withResolvers();
  let starts = 0;
  await page.route('**/api/live', async (route) => {
    starts++;
    intercepted.resolve();
    await held.promise;
    await route.continue();
  });
  t.after(() => held.resolve());
  await page.goto(server.origin);
  await page.locator('[data-demo="single"] [data-action="live"]').click();
  await intercepted.promise;
  assert.ok(await page.locator('[data-demo="single"] [data-action="live"]').isDisabled());
  await page.evaluate(() => document.querySelector('[data-demo="cascade"] [data-action="live"]').click());
  held.resolve();
  await page.getByRole('button', { name: 'Stop the run', exact: true }).waitFor();
  assert.equal(starts, 1);
});

test('replay controls wait for recordings instead of dropping clicks on a slow connection', { timeout: 30_000 }, async (t) => {
  const held = Promise.withResolvers();
  const intercepted = Promise.withResolvers();
  t.after(() => held.resolve());
  const server = await startServer({ port: 0, auth: { enabled: false } });
  t.after(() => server.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.route('**/api/recordings', async (route) => {
    intercepted.resolve();
    await held.promise;
    await route.continue();
  });
  await page.goto(server.origin);
  await intercepted.promise;
  const replay = page.locator('[data-demo="single"] [data-action="reference"]');
  assert.ok(await replay.isDisabled());
  assert.ok(await page.locator('[data-demo="single"] [data-action="live"]').isDisabled());
  held.resolve();
  await replay.click();
  await page.locator('#viewer [data-role="badge"]').filter({ hasText: /^Finished$/ }).waitFor();
});

test('the simplified dashboard retains every interactive view and resumes a run after visiting tutorials', { timeout: 60_000 }, async (t) => {
  const runner = heldRuns();
  const server = await startServer({
    port: 0, auth: { enabled: true }, runLive: runner.runLive, save: async () => {},
    runChecks: async () => CHECKS.map((check) => ({ id: check.id, matchesExpected: true, measured: check.expected })),
  });
  t.after(() => server.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(server.origin);
  await page.locator('[data-demo="single"] [data-action="reference"]:enabled').waitFor();
  assert.equal(await page.locator('main > section').first().getAttribute('id'), 'try');
  assert.equal(await page.locator('#demo-cards [data-action="live"]').count(), 3);
  assert.equal(await page.locator('#demo-cards [data-action="reference"]').count(), 3);
  assert.equal(await page.locator('#demo-cards [data-action="last"]').count(), 3);
  assert.equal(await page.locator('#run-details').isVisible(), false);
  const button = await page.locator('[data-demo="single"] [data-action="live"]').boundingBox();
  assert.ok(button.y + button.height < 900, 'Live controls should be on the first desktop screen.');

  await page.locator('[data-demo="cascade"] [data-action="reference"]').click();
  await page.getByRole('button', { name: 'Skip to the end', exact: true }).click();
  await page.locator('#viewer [data-role="badge"]').filter({ hasText: /^Finished$/ }).waitFor();
  await page.locator('#run-details > summary').click();
  assert.ok(await page.locator('[data-slot="request"]').innerText());
  assert.match(await page.locator('[data-slot="plan"]').innerText(), /Cascade/);
  assert.equal(await page.locator('.pattern-row.active').getAttribute('data-pattern'), 'cascade');
  assert.equal(await page.locator('#token-prices tr').count(), 4);
  assert.match(await page.locator('#token-prices').innerText(), /Not recorded/);

  await page.getByRole('button', { name: 'Run the checks', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#checks-status').textContent.startsWith('8 of 8'));
  const snippet = page.locator('#checks-body details').first();
  await snippet.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#checks-body details').dataset.loaded === '1');
  assert.match(await snippet.locator('code').textContent(), /page\.evaluate/);
  await page.getByText('Preview the demo page', { exact: true }).click();
  assert.ok(await page.getByTitle('Demo page with accessibility problems built in').isVisible());

  await page.locator('#cost summary').filter({ hasText: /^Reference run costs$/ }).click();
  assert.ok(await page.locator('#reference-costs table').isVisible());
  await page.locator('#cost summary').filter({ hasText: /^Saved live runs$/ }).click();
  assert.ok(await page.locator('#live-costs table').isVisible());
  await page.locator('#live-costs').getByRole('button', { name: /^Replay/ }).first().click();
  await page.getByRole('button', { name: 'Skip to the end', exact: true }).click();
  await page.locator('#viewer [data-role="badge"]').filter({ hasText: /^Finished$/ }).waitFor();
  await page.locator('[data-demo="single"] [data-action="last"]').click();
  await page.getByRole('button', { name: 'Skip to the end', exact: true }).click();
  await page.locator('#viewer [data-role="badge"]').filter({ hasText: /^Finished$/ }).waitFor();

  const starting = page.waitForResponse((res) => res.url().endsWith('/api/live') && res.request().method() === 'POST');
  await page.locator('[data-demo="single"] [data-action="live"]').click();
  const { run } = await (await starting).json();
  await page.getByRole('button', { name: 'Stop the run', exact: true }).waitFor();
  await page.getByRole('navigation').getByRole('link', { name: 'Tutorials', exact: true }).click();
  await page.getByRole('heading', { name: 'HydraFusion tutorials', exact: true }).waitFor();
  assert.equal(await page.locator('script').count(), 0);
  assert.equal(runner.runs[0].signal.aborted, false);
  assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 1);
  const resumed = page.waitForRequest((req) => req.url().includes(`/api/live/${run.id}?after=0`));
  await page.getByRole('navigation').getByRole('link', { name: 'Back to demos', exact: true }).click();
  await resumed;
  await page.getByRole('button', { name: 'Stop the run', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => JSON.parse(sessionStorage.getItem('hydrafusion.live-run')))).id, run.id);
  runner.runs[0].finish();
  await page.locator('#viewer [data-role="badge"]').filter({ hasText: /^Finished$/ }).waitFor();
  assert.deepEqual(errors, []);
});

test('dashboard and tutorials keep their content within narrow screens', { timeout: 30_000 }, async (t) => {
  const server = await startServer({ port: 0, auth: { enabled: false } });
  t.after(() => server.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const pathname of ['/', '/tutorials.html']) {
      await page.goto(`${server.origin}${pathname}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        for (const details of document.querySelectorAll('details:not([hidden])')) details.open = true;
      });
      const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(dimensions.content <= dimensions.viewport, `${pathname} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
      const brokenAnchors = await page.locator('a[href^="#"]').evaluateAll((links) =>
        links.filter((link) => !document.getElementById(link.hash.slice(1))).map((link) => link.hash));
      assert.deepEqual(brokenAnchors, []);
    }
  }
});
