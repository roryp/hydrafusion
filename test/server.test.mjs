import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startServer } from '../src/server.mjs';

const KEY = 'test-key';
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

  test('lists the reference runs', async () => {
    const { recordings } = await (await fetch(`${server.origin}/api/recordings`)).json();
    assert.deepEqual(recordings.filter((r) => r.source === 'reference').map((r) => r.pattern), ['critique', 'cascade', 'single']);
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
      liveRunKey: KEY,
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

  test('need the access key', async () => {
    assert.equal((await start('single')).status, 403);
    assert.equal((await start('single', { 'X-Live-Key': 'wrong' })).status, 403);
    const config = await (await fetch(`${server.origin}/api/config`, { headers: { 'X-Live-Key': KEY } })).json();
    assert.deepEqual([config.live.needsKey, config.live.keyAccepted, config.live.remainingToday], [true, true, 2]);
  });

  test('refuse other sites and non-JSON requests', async () => {
    assert.equal((await start('single', { 'X-Live-Key': KEY, Origin: 'https://example.com' })).status, 403);
    const res = await fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Live-Key': KEY }, body: '{"demo":"single"}' });
    assert.equal(res.status, 403);
    assert.equal((await start('nope', { 'X-Live-Key': KEY })).status, 400);
  });

  test('run in the background, one at a time, and can be followed and saved', async () => {
    const res = await start('single', { 'X-Live-Key': KEY });
    assert.equal(res.status, 202);
    const { run } = await res.json();

    const busy = await start('cascade', { 'X-Live-Key': KEY });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).activeRun.id, run.id);
    assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).activeRun.id, run.id);

    const { events, recordingId } = await follow(server.origin, run.id);
    assert.deepEqual(events.map((e) => e.type), ['run.started', 'session.fusion_resolved', 'run.finished']);
    assert.equal(recordingId, 'test-single');
    assert.equal(saved.at(-1).id, 'test-single');
    assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).activeRun, null);
  });

  test('can be stopped with the key', async () => {
    const { run } = await (await start('critique', { 'X-Live-Key': KEY })).json();
    const stop = (headers) => fetch(`${server.origin}/api/live/${run.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await stop({})).status, 403);
    assert.equal((await stop({ 'X-Live-Key': KEY })).status, 202);
    const { events } = await follow(server.origin, run.id);
    assert.deepEqual(events.at(-1).data, { ok: false, error: 'Stopped.', durationMs: 300 });
  });

  test('stop at the daily limit', async () => {
    const res = await start('single', { 'X-Live-Key': KEY });
    assert.equal(res.status, 429);
    assert.equal((await fetch(`${server.origin}/api/live/00000000-0000-0000-0000-000000000000`)).status, 404);
  });
});
