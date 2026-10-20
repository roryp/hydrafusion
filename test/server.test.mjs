import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startServer } from '../src/server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stands in for a live run: no Copilot session and no AIU.
async function fakeRun(demo, { onEvent, signal }) {
  const events = [];
  const emit = (t, type, data) => {
    const event = { t, type, data };
    events.push(event);
    onEvent(event);
  };
  emit(0, 'run.started', { demoId: demo.id, title: demo.title, tier: demo.tier, model: demo.model, prompt: demo.prompt, source: 'live' });
  for (let i = 0; i < 20 && !signal.aborted; i++) await sleep(10);
  emit(250, 'session.fusion_resolved', { pattern: 'single', phasePlan: [{ kind: 'primary', scope: 'root', conditional: false }] });
  emit(300, 'run.finished', signal.aborted ? { ok: false, error: 'Stopped.', durationMs: 300 } : { ok: true, durationMs: 300 });
  return { id: `test-${demo.id}`, title: demo.title, source: 'live', demoId: demo.id, events };
}

function getWithHost(origin, path, host) {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

async function follow(origin, id) {
  const events = [];
  let after = 0;
  for (;;) {
    const body = await (await fetch(`${origin}/api/live/${id}?after=${after}`)).json();
    events.push(...body.events);
    after = body.next;
    if (body.done) return { events, recordingId: body.recordingId };
  }
}

describe('static files and recordings', () => {
  let server;
  before(async () => {
    server = await startServer({ port: 0, auth: { enabled: false } });
  });
  after(() => server.close());

  test('serves the dashboard, the demo page, the shared modules and axe-core', async () => {
    for (const [path, type] of [['/', 'text/html'], ['/demo-page/', 'text/html'], ['/shared/trace.mjs', 'text/javascript'], ['/vendor/axe.min.js', 'text/javascript'], ['/checks/04-keyboard.js', 'text/javascript'], ['/healthz', 'text/plain']]) {
      const res = await fetch(`${server.origin}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), new RegExp(type), path);
    }
  });

  test('introduces HydraFusion below the title and before the section navigation', async () => {
    const html = await (await fetch(`${server.origin}/`)).text();
    const intro = html.match(/<h1>[^<]+<\/h1>\s*<p class="subtitle">([^<]+)<\/p>\s*<nav\b/)?.[1];
    assert.equal(intro, 'HydraFusion is a GitHub Copilot model, in research preview, that plans each request and picks a model for each step. This app runs three prompts against a web page with accessibility problems built in, and shows which pattern HydraFusion picked, each step as it runs, and what it cost.');
  });

  test('lists the reference runs and a recorded live run of each demo', async () => {
    const { recordings } = await (await fetch(`${server.origin}/api/recordings`)).json();
    assert.deepEqual(recordings.filter((r) => r.source === 'reference').map((r) => r.pattern), ['critique', 'cascade', 'single']);
    const live = recordings.filter((r) => r.source === 'live' && r.status === 'done');
    for (const demo of ['single', 'critique', 'cascade']) {
      const run = live.find((r) => r.demoId === demo);
      assert.ok(run, `no recorded live run of the ${demo} demo`);
      assert.ok(run.rows.length > 0 && run.aiu > 0, `${demo} run has no cost rows`);
      const recording = await (await fetch(`${server.origin}/api/recordings/${run.id}`)).json();
      assert.equal(recording.events.at(-1).type, 'run.finished');
    }
  });

  test('refuses path traversal', async () => {
    assert.equal((await fetch(`${server.origin}/shared/..%2f..%2fpackage.json`)).status, 403);
  });

  test('answers only to the hosts it knows', async () => {
    // fetch() won't send a custom Host header, so DNS rebinding is simulated with http.get.
    assert.equal(await getWithHost(server.origin, '/api/recordings', 'attacker.example'), 403);
    const configured = await startServer({ port: 0, auth: { enabled: false }, allowedHosts: ['demo.example.net'] });
    try {
      assert.equal(await getWithHost(configured.origin, '/api/recordings', 'demo.example.net'), 200);
    } finally {
      await configured.close();
    }
  });

  test('says when live runs are off', async () => {
    const { live } = await (await fetch(`${server.origin}/api/config`)).json();
    assert.equal(live.enabled, false);
    const res = await fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":"single"}' });
    assert.equal(res.status, 503);
  });
});

describe('live runs', () => {
  let server;
  const saved = [];
  before(async () => {
    server = await startServer({
      port: 0,
      auth: { enabled: true },
      dailyLimit: 2,
      runLive: fakeRun,
      save: async (recording) => saved.push(recording),
    });
  });
  after(() => server.close());

  const start = (demo, headers = {}) => fetch(`${server.origin}/api/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ demo }),
  });

  test('refuse other sites and non-JSON requests', async () => {
    assert.equal((await start('single', { Origin: 'https://example.com' })).status, 403);
    const res = await fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"demo":"single"}' });
    assert.equal(res.status, 403);
    assert.equal((await start('nope')).status, 400);
    const { live } = await (await fetch(`${server.origin}/api/config`)).json();
    assert.deepEqual([live.enabled, live.remainingToday], [true, 2]);
  });

  test('run in the background, one at a time, and can be followed and saved', async () => {
    const res = await start('single');
    assert.equal(res.status, 202);
    const { run } = await res.json();

    const busy = await start('cascade');
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).activeRun.id, run.id);
    assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).activeRun.id, run.id);

    const { events, recordingId } = await follow(server.origin, run.id);
    assert.deepEqual(events.map((e) => e.type), ['run.started', 'session.fusion_resolved', 'run.finished']);
    assert.equal(recordingId, 'test-single');
    assert.equal(saved.at(-1).id, 'test-single');
    assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).activeRun, null);
  });

  test('can be stopped', async () => {
    const { run } = await (await start('critique')).json();
    const stop = await fetch(`${server.origin}/api/live/${run.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(stop.status, 202);
    const { events } = await follow(server.origin, run.id);
    assert.deepEqual(events.at(-1).data, { ok: false, error: 'Stopped.', durationMs: 300 });
  });

  test('stop at the daily limit', async () => {
    assert.equal((await start('single')).status, 429);
    assert.equal((await fetch(`${server.origin}/api/live/00000000-0000-0000-0000-000000000000`)).status, 404);
  });
});
