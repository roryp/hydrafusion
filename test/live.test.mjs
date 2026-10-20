import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { browserServerConfig, runLiveDemo } from '../src/live.mjs';
import { RUNS_DIR } from '../src/paths.mjs';
import { DEMOS } from '../src/shared/demos.mjs';

test('same-demo runs in the same millisecond have distinct recording IDs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
  const recordings = await Promise.all(Array.from({ length: 10 }, () => runLiveDemo(DEMOS[0], { auth: { enabled: false } })));
  assert.equal(new Set(recordings.map((recording) => recording.id)).size, 10);
  for (const recording of recordings) {
    assert.match(recording.id, /^2026-10-20_12-00-00-single-[0-9a-f-]{36}$/);
    assert.equal(recording.events.at(-1).data.ok, false, 'ID test must not start a billable run');
  }
});

test('browser sessions use isolated profiles and separate output directories', () => {
  const pageUrl = 'http://127.0.0.1:4173/demo-page/';
  const first = browserServerConfig(pageUrl, 'first-run');
  const second = browserServerConfig(pageUrl, 'second-run');
  const output = (config) => config.args[config.args.indexOf('--output-dir') + 1];
  assert.ok(first.args.includes('--isolated'));
  assert.ok(second.args.includes('--isolated'));
  assert.equal(output(first), path.join(RUNS_DIR, 'playwright-mcp', 'first-run'));
  assert.equal(output(second), path.join(RUNS_DIR, 'playwright-mcp', 'second-run'));
  assert.notEqual(output(browserServerConfig(pageUrl)), output(browserServerConfig(pageUrl)));
  assert.equal(first.args[first.args.indexOf('--allowed-origins') + 1], new URL(pageUrl).origin);
});
