import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { FUSION_FEATURE_FLAGS, browserServerConfig, runLiveDemo } from '../src/live.mjs';
import { RUNS_DIR } from '../src/paths.mjs';
import { DEMOS, TIERS, effortLabel } from '../src/shared/demos.mjs';

test('Fusion effort names preserve the SDK routing identifiers and original demo choices', () => {
  assert.deepEqual(TIERS, { Standard: 'auto', High: 'hydrafusion', Max: 'hydrafusion-max' });
  assert.deepEqual(DEMOS.map(({ id, tier, model }) => ({ id, tier, model })), [
    { id: 'single', tier: 'High', model: TIERS.High },
    { id: 'critique', tier: 'Max', model: TIERS.Max },
    { id: 'cascade', tier: 'High', model: TIERS.High },
  ]);
  assert.equal(effortLabel('Standard'), 'Fusion Standard effort');
  assert.equal(effortLabel('High'), 'Fusion High effort');
  assert.equal(effortLabel('Max'), 'Fusion Max effort');
  assert.equal(effortLabel('Default'), 'Fusion High effort');
  assert.deepEqual(FUSION_FEATURE_FLAGS, { HYDRAFUSION: true, HYDRAFUSION_ROLLOUT: true, HYDRAFUSION_PLAN_V2: true });
});

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

test('Fusion browser settings take precedence while legacy environment names still work', (t) => {
  const names = ['FUSION_BROWSER', 'FUSION_HEADED', 'HF_BROWSER', 'HF_HEADED'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.FUSION_BROWSER;
  delete process.env.FUSION_HEADED;
  process.env.HF_BROWSER = 'msedge';
  process.env.HF_HEADED = '1';
  const legacy = browserServerConfig();
  assert.equal(legacy.args[legacy.args.indexOf('--browser') + 1], 'msedge');
  assert.ok(!legacy.args.includes('--headless'));
  process.env.FUSION_BROWSER = 'chromium';
  process.env.FUSION_HEADED = '';
  const current = browserServerConfig();
  assert.equal(current.args[current.args.indexOf('--browser') + 1], 'chromium');
  assert.ok(current.args.includes('--headless'));
});
