import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser } from '../checks/run-checks.mjs';
import { startServer } from '../src/server.mjs';
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
