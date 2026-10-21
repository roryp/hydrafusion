import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startServer } from '../src/server.mjs';
import { heldRuns, pendingPost } from './helpers.mjs';

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

  test('serves the dashboard, tutorials, demo page, shared modules and axe-core', async () => {
    for (const [path, type] of [['/', 'text/html'], ['/tutorials.html', 'text/html'], ['/demo-page/', 'text/html'], ['/shared/trace.mjs', 'text/javascript'], ['/vendor/axe.min.js', 'text/javascript'], ['/checks/04-keyboard.js', 'text/javascript'], ['/healthz', 'text/plain']]) {
      const res = await fetch(`${server.origin}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), new RegExp(type), path);
    }
  });

  test('keeps the dashboard concise and moves the tutorials to a linked static page', async () => {
    const html = await (await fetch(`${server.origin}/`)).text();
    const intro = html.match(/<h1>[^<]+<\/h1>\s*<p class="subtitle">([^<]+)<\/p>\s*<nav\b/)?.[1];
    assert.equal(intro, 'Run HydraFusion live, replay a recording, or check the demo page.');
    assert.match(html, /href="\/tutorials\.html">Tutorials<\/a>/);
    const tutorials = await (await fetch(`${server.origin}/tutorials.html`)).text();
    for (const heading of ['What HydraFusion is', 'Three patterns', 'How the app works', 'Live runs and replays', 'Workshop', 'The browser tools']) {
      assert.ok(tutorials.includes(`>${heading}</h`), `Missing tutorial: ${heading}`);
      assert.ok(!html.includes(`>${heading}</h`), `Tutorial still on the main page: ${heading}`);
    }
    assert.match(tutorials, /href="\/#try">Back to demos<\/a>/);
    assert.doesNotMatch(tutorials, /<script\b/);
    for (const id of ['demo-cards', 'viewer', 'run-details', 'pattern-rows', 'token-prices', 'run-checks', 'checks-body', 'reference-costs', 'live-costs']) {
      assert.ok(html.includes(`id="${id}"`), `Missing interactive view: ${id}`);
    }
  });

  test('serves every tutorial screenshot, each with alt text', async () => {
    const tutorials = await (await fetch(`${server.origin}/tutorials.html`)).text();
    const images = [...tutorials.matchAll(/<img\b[^>]*>/g)].map(([tag]) => ({ src: tag.match(/\bsrc="([^"]+)"/)?.[1], alt: tag.match(/\balt="([^"]*)"/)?.[1] }));
    assert.ok(images.length, 'The tutorials have no screenshots');
    for (const { src, alt } of images) {
      assert.ok(alt?.trim(), `${src} has no alt text`);
      const res = await fetch(`${server.origin}${src}`);
      assert.equal(res.status, 200, src);
      assert.equal(res.headers.get('content-type'), 'image/png', src);
      assert.ok((await res.arrayBuffer()).byteLength > 0, src);
    }
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
      concurrencyLimit: 1,
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
    assert.match((await busy.json()).error, /slots are busy/);
    assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).activeRuns[0].id, run.id);

    const { events, recordingId } = await follow(server.origin, run.id);
    assert.deepEqual(events.map((e) => e.type), ['run.started', 'session.fusion_resolved', 'run.finished']);
    assert.equal(recordingId, 'test-single');
    assert.equal(saved.at(-1).id, 'test-single');
    assert.deepEqual((await (await fetch(`${server.origin}/api/config`)).json()).activeRuns, []);
  });

  describe('concurrent users', () => {
    test('admits five independent runs, rejects a sixth, and stops only the selected run', async (t) => {
      const runner = heldRuns();
      const saved = [];
      const server = await startServer({ port: 0, auth: { enabled: true }, dailyLimit: 10, runLive: runner.runLive, save: async (recording) => saved.push(recording) });
      t.after(() => server.close());
      const start = () => fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":"cascade"}' });
      const responses = await Promise.all(Array.from({ length: 5 }, start));
      assert.deepEqual(responses.map((res) => res.status), [202, 202, 202, 202, 202]);
      const runs = await Promise.all(responses.map(async (res) => (await res.json()).run));
      assert.equal(new Set(runs.map((run) => run.id)).size, 5);
      let config = await (await fetch(`${server.origin}/api/config`)).json();
      assert.equal(config.live.concurrencyLimit, 5);
      assert.equal(config.live.activeCount, 5);
      assert.equal(config.live.remainingToday, 5);
      assert.equal((await start()).status, 409);

      await fetch(`${server.origin}/api/live/${runs[0].id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const stopped = await follow(server.origin, runs[0].id);
      assert.equal(stopped.events.at(-1).data.ok, false);
      assert.equal(runner.runs.filter((run) => run.signal.aborted).length, 1);
      config = await (await fetch(`${server.origin}/api/config`)).json();
      assert.equal(config.live.activeCount, 4);
      assert.equal(config.live.remainingToday, 5, 'rejected starts must not consume the daily allowance');

      const replacement = await start();
      assert.equal(replacement.status, 202);
      runs.push((await replacement.json()).run);
      for (const run of runner.runs) run.finish();
      const completed = await Promise.all(runs.map((run) => follow(server.origin, run.id)));
      assert.equal(new Set(completed.map((run) => run.recordingId)).size, 6);
      assert.equal(saved.length, 6);
      for (const result of completed) {
        const started = result.events.find((event) => event.type === 'run.started');
        assert.equal(started.data.marker, result.recordingId, 'events must belong to the same recording');
        assert.equal(result.events.filter((event) => event.type === 'run.started').length, 1);
      }
      assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 0);
    });

    test('checks the daily cap after concurrent request bodies finish arriving', async (t) => {
      const runner = heldRuns();
      const server = await startServer({ port: 0, auth: { enabled: true }, dailyLimit: 1, runLive: runner.runLive, save: async () => {} });
      t.after(() => server.close());
      const requests = Array.from({ length: 5 }, () => pendingPost(server.origin, '/api/live'));
      await Promise.all(requests.map((req) => req.ready));
      for (const req of requests) req.send({ demo: 'single' });
      const responses = await Promise.all(requests.map((req) => req.response));
      assert.deepEqual(responses.map((res) => res.status).sort(), [202, 429, 429, 429, 429]);
      assert.equal(runner.runs.length, 1);
      assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.remainingToday, 0);
    });

    test('keeps the slot occupied until the recording is saved', async (t) => {
      const saving = Promise.withResolvers();
      const startedSaving = Promise.withResolvers();
      const server = await startServer({
        port: 0, auth: { enabled: true }, concurrencyLimit: 1, runLive: fakeRun,
        save: async () => { startedSaving.resolve(); await saving.promise; },
      });
      t.after(async () => { saving.resolve(); await server.close(); });
      const start = () => fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":"single"}' });
      const { run } = await (await start()).json();
      await startedSaving.promise;
      assert.equal((await start()).status, 409);
      saving.resolve();
      await follow(server.origin, run.id);
      assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 0);
    });

    test('reports runner and save failures and releases their slots', async (t) => {
      for (const failure of ['runner', 'save']) {
        const server = await startServer({
          port: 0, auth: { enabled: true }, concurrencyLimit: 1,
          runLive: failure === 'runner' ? async () => { throw new Error('Runner failed.'); } : fakeRun,
          save: async () => { throw new Error('Save failed.'); },
        });
        t.after(() => server.close());
        const { run } = await (await fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":"single"}' })).json();
        const result = await follow(server.origin, run.id);
        assert.equal(result.events.at(-1).data.ok, false);
        assert.match(result.events.at(-1).data.error, /failed/);
        assert.equal(result.recordingId, null);
        assert.equal((await (await fetch(`${server.origin}/api/config`)).json()).live.activeCount, 0);
      }
    });

    test('shutdown aborts and waits for every active run', async () => {
      const runner = heldRuns();
      const saved = [];
      const server = await startServer({ port: 0, auth: { enabled: true }, runLive: runner.runLive, save: async (recording) => saved.push(recording) });
      try {
        await Promise.all(Array.from({ length: 5 }, () => fetch(`${server.origin}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"demo":"single"}' })));
      } finally {
        await server.close();
      }
      assert.equal(runner.runs.length, 5);
      assert.ok(runner.runs.every((run) => run.signal.aborted));
      assert.equal(saved.length, 5);
    });

    test('shares concurrent checks and allows a fresh execution afterwards', async (t) => {
      const checking = Promise.withResolvers();
      let calls = 0;
      const results = [{ id: randomUUID(), matchesExpected: true }];
      const server = await startServer({
        port: 0, auth: { enabled: false },
        runChecks: async () => { calls++; await checking.promise; return results; },
      });
      t.after(async () => { checking.resolve(); await server.close(); });
      const requests = Array.from({ length: 5 }, () => pendingPost(server.origin, '/api/checks'));
      await Promise.all(requests.map((req) => req.ready));
      for (const req of requests) req.send({});
      assert.equal(calls, 1);
      checking.resolve();
      const responses = await Promise.all(requests.map((req) => req.response));
      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.results, results);
      }
      assert.equal(calls, 1);
      const next = await fetch(`${server.origin}/api/checks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(next.status, 200);
      assert.equal(calls, 2);
    });

    test('reports shared check errors to every caller and permits retry', async (t) => {
      const checking = Promise.withResolvers();
      let calls = 0;
      const server = await startServer({
        port: 0, auth: { enabled: false },
        runChecks: async () => { calls++; await checking.promise; throw new Error('Browser unavailable.'); },
      });
      t.after(async () => { checking.resolve(); await server.close(); });
      const requests = Array.from({ length: 5 }, () => pendingPost(server.origin, '/api/checks'));
      await Promise.all(requests.map((req) => req.ready));
      for (const req of requests) req.send({});
      checking.resolve();
      for (const res of await Promise.all(requests.map((req) => req.response))) {
        assert.equal(res.status, 500);
        assert.equal(res.body.error, 'Browser unavailable.');
      }
      assert.equal(calls, 1);
      assert.equal((await fetch(`${server.origin}/api/checks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 500);
      assert.equal(calls, 2);
    });

    test('rejects invalid limits rather than silently removing spending or capacity guards', async () => {
      for (const concurrencyLimit of [0, -1, 1.5, NaN, Infinity]) {
        await assert.rejects(startServer({ port: 0, concurrencyLimit }), /CONCURRENCY_LIMIT/);
      }
      for (const dailyLimit of [-1, 1.5, NaN, Infinity]) {
        await assert.rejects(startServer({ port: 0, dailyLimit }), /DAILY_LIMIT/);
      }
    });
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
