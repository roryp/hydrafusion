import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchBrowser } from '../checks/run-checks.mjs';
import { isMain } from '../src/paths.mjs';
import { CHECKS } from '../src/shared/checks.mjs';
import { buildTrace, currentPattern, finalAnswer, totals } from '../src/shared/trace.mjs';

const RESPONSIVENESS_LIMIT_MS = 3000;
const BROWSER_DEMOS = ['critique', 'cascade'];

export async function testDemoLoad({ baseUrl, users = 5, timeoutMs = 22 * 60_000 }) {
  assert.ok(Number.isSafeInteger(users) && users > 0, 'Users must be a positive integer.');
  const origin = new URL(baseUrl).origin;
  const request = async (pathname, body) => {
    const res = await fetch(`${origin}${pathname}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json() };
  };
  const config = await request('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.live.enabled, true, 'Live runs are disabled.');
  assert.equal(config.body.live.activeCount, 0, 'Wait for other visitors to finish before running a load test.');
  assert.equal(config.body.live.concurrencyLimit, users, 'Use the deployed concurrency limit to test saturation.');
  assert.ok(config.body.live.remainingToday == null || config.body.live.remainingToday >= users, 'Not enough daily allowance for this test.');

  const browser = await launchBrowser();
  const started = [];
  const finished = new Set();
  const pageErrors = [];
  const samples = [];
  const availabilityErrors = [];
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const monitoring = (async () => {
    while (!controller.signal.aborted) {
      const before = performance.now();
      try {
        const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'ok');
        samples.push(performance.now() - before);
      } catch (err) {
        if (!controller.signal.aborted) availabilityErrors.push(err.message);
      }
      try {
        await sleep(2000, undefined, { signal: controller.signal });
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
      }
    }
  })();

  const follow = async (run) => {
    const events = [];
    let after = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await request(`/api/live/${run.id}?after=${after}`);
      assert.equal(result.status, 200, `Polling ${run.id}: ${JSON.stringify(result.body)}`);
      const body = result.body;
      assert.equal(body.next, after + body.events.length, 'Event cursor skipped or repeated events.');
      events.push(...body.events);
      after = body.next;
      if (!body.done) continue;
      finished.add(run.id);
      const ending = events.at(-1);
      assert.equal(ending?.type, 'run.finished');
      assert.equal(ending.data.ok, true, `Run ${run.id}: ${ending.data.error}`);
      assert.equal(events.filter((event) => event.type === 'run.started').length, 1);
      assert.equal(events.find((event) => event.type === 'run.started').data.demoId, run.demoId);
      assert.equal(events.filter((event) => event.type === 'session.error').length, 0, 'A model request reported an error.');
      assert.ok(events.some((event) => event.type === 'session.fusion_resolved'), 'HydraFusion did not return a route.');
      const trace = buildTrace(events);
      assert.ok(finalAnswer(trace)?.content.trim(), 'No final answer was returned.');
      assert.ok(trace.tools.some((tool) => tool.name === 'browser_navigate' && tool.status === 'ok'), 'The run did not navigate to the demo page.');
      assert.ok(trace.usage.length > 0, 'No model usage was recorded.');
      const recording = await request(`/api/recordings/${encodeURIComponent(body.recordingId)}`);
      assert.equal(recording.status, 200, 'The completed recording is not available for replay.');
      assert.equal(recording.body.demoId, run.demoId);
      // The runner trims the initial model catalogue when saving; the rest of the stream must match.
      const withoutCatalog = (event) => event.type === 'run.started' ? { ...event, data: { ...event.data, models: null } } : event;
      assert.deepEqual(recording.body.events.map(withoutCatalog), events.map(withoutCatalog), 'The saved recording differs from the live event stream.');
      const sum = totals(trace);
      return {
        runId: run.id, recordingId: body.recordingId, demo: run.demoId, pattern: currentPattern(trace),
        durationMs: sum.durationMs, aiu: sum.reportedAiu ?? sum.aiu, modelRequests: trace.usage.length, browserTools: trace.tools.length,
      };
    }
    throw new Error(`Run ${run.id} exceeded ${timeoutMs}ms.`);
  };

  try {
    const pages = await Promise.all(Array.from({ length: users }, async () => {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('dialog', (dialog) => dialog.accept());
      await page.goto(origin, { waitUntil: 'networkidle' });
      return page;
    }));
    const starts = await Promise.allSettled(pages.map(async (page, i) => {
      const response = page.waitForResponse((res) => res.url().endsWith('/api/live') && res.request().method() === 'POST');
      const before = performance.now();
      await page.locator(`[data-demo="${BROWSER_DEMOS[i % BROWSER_DEMOS.length]}"] [data-action="live"]`).click();
      const res = await response;
      const body = await res.json();
      assert.equal(res.status(), 202, JSON.stringify(body));
      started.push(body.run);
      return { ...body.run, startResponseMs: Math.round(performance.now() - before) };
    }));
    const startErrors = starts.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (startErrors.length) throw new AggregateError(startErrors, 'Some users could not start a run.');
    const runs = starts.map((result) => result.value);
    assert.equal(new Set(runs.map((run) => run.id)).size, users);
    const during = await request('/api/config');
    assert.equal(during.body.live.activeCount, users, 'The requested number of model sessions did not overlap.');
    const overload = await request('/api/live', { demo: 'single' });
    if (overload.status === 202 && overload.body.run) started.push(overload.body.run);
    assert.equal(overload.status, 409, 'The saturated app did not reject an extra run.');
    const afterOverload = await request('/api/config');
    assert.equal(afterOverload.body.live.remainingToday, during.body.live.remainingToday, 'A rejected run consumed the daily allowance.');

    const resumed = pages[0].waitForRequest((req) => req.url().includes(`/api/live/${runs[0].id}?after=0`));
    await pages[0].reload();
    await resumed;
    const replay = await browser.newPage({ reducedMotion: 'reduce' });
    replay.on('pageerror', (err) => pageErrors.push(err.message));
    await replay.goto(origin);
    assert.equal(await replay.getByRole('button', { name: 'Stop the run', exact: true }).count(), 0, 'A fresh visitor joined someone else\'s run.');
    await replay.locator('[data-demo="single"] [data-action="reference"]').click();
    await replay.getByRole('button', { name: 'Skip to the end', exact: true }).click();
    await replay.waitForFunction(() => document.querySelector('#viewer [data-role="badge"]').textContent === 'Finished');

    console.error(`Started ${users} independent browser-backed live runs on ${origin}; saturation, reload and replay checks passed.`);
    const [results, checkResponses] = await Promise.all([
      Promise.all(runs.map(follow)),
      Promise.all(Array.from({ length: users }, () => request('/api/checks', {}))),
    ]);
    for (const checks of checkResponses) {
      assert.equal(checks.status, 200);
      assert.equal(checks.body.results.length, CHECKS.length);
      assert.ok(checks.body.results.every((result) => result.matchesExpected), JSON.stringify(checks.body.results.filter((result) => !result.matchesExpected)));
    }
    assert.equal(new Set(results.map((result) => result.recordingId)).size, users, 'Concurrent recordings overwrote one another.');
    await Promise.all(pages.map((page) => page.waitForFunction(() =>
      document.querySelector('#viewer [data-role="badge"]').textContent === 'Finished'
      && !document.querySelector('[data-action="live"]').disabled, null, { timeout: 30_000 })));
    assert.deepEqual(pageErrors, [], 'Dashboard JavaScript errors.');
    assert.deepEqual(availabilityErrors, [], 'Health endpoint failed during load.');
    assert.equal((await request('/api/config')).body.live.activeCount, 0);
    assert.ok(samples.length > 0);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert.ok(p95 < RESPONSIVENESS_LIMIT_MS, `Health p95 ${Math.round(p95)}ms exceeds ${RESPONSIVENESS_LIMIT_MS}ms.`);
    return {
      ok: true, origin, startedAt, finishedAt: new Date().toISOString(), concurrentUsers: users,
      successfulRuns: results.length, checksPerUser: CHECKS.length, overloadStatus: overload.status,
      health: { samples: samples.length, errors: availabilityErrors.length, p95Ms: Math.round(p95), maxMs: Math.round(sorted.at(-1)), p95LimitMs: RESPONSIVENESS_LIMIT_MS },
      runs: results.map((result, i) => ({ ...result, startResponseMs: runs[i].startResponseMs })),
    };
  } finally {
    controller.abort();
    await monitoring;
    for (const run of started.filter((run) => !finished.has(run.id))) {
      try {
        const result = await request(`/api/live/${run.id}/stop`, {});
        assert.equal(result.status, 202);
      } catch (err) {
        console.error(`Could not stop test run ${run.id}: ${err.message}`);
      }
    }
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  const [baseUrl, users = '5'] = process.argv.slice(2);
  try {
    assert.ok(baseUrl, 'Usage: npm run test:load -- <app-url> [users=5]. This starts billable Copilot runs.');
    console.log(JSON.stringify(await testDemoLoad({ baseUrl, users: Number(users) }), null, 2));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
