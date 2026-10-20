// Serves the dashboard, the demo page and a small JSON API:
//   GET  /api/config              what this server allows, and the live runs in progress
//   GET  /api/demos               the three demos
//   GET  /api/recordings          reference runs and saved live runs
//   GET  /api/recordings/:id      one recording, for replay
//   POST /api/live {demo}         starts a live run, which spends AIU, and returns its id
//   GET  /api/live/:id?after=n    waits for the run's events from index n (long poll)
//   POST /api/live/:id/stop       stops a live run
//   GET  /api/checks              the accessibility checks
//   POST /api/checks              runs them against the demo page
//   GET  /healthz
//
// Settings come from environment variables:
//   PORT, HOST              where to listen (default 127.0.0.1:4173)
//   ALLOWED_HOSTS           extra host names the API answers to, comma-separated (for example the Azure host name)
//   COPILOT_GITHUB_TOKEN    GitHub token for live runs; without it they use the signed-in account
//   LIVE_RUN_DAILY_LIMIT    most live runs to start per UTC day (0 means no limit)
//   LIVE_RUN_CONCURRENCY_LIMIT  most live runs at once (default 5)

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { liveAuth, runLiveDemo } from './live.mjs';
import { DEMO_PAGE_DIR, ROOT, isInside, isMain } from './paths.mjs';
import { listRecordings, loadRecording, saveRecording } from './recordings.mjs';
import { CHECKS } from './shared/checks.mjs';
import { DEMOS, findDemo } from './shared/demos.mjs';

const require = createRequire(import.meta.url);

const POLL_WAIT_MS = 20_000;
const KEEP_FINISHED_RUNS_MS = 60 * 60_000;

const STATIC_DIRS = [
  ['/demo-page/', DEMO_PAGE_DIR],
  ['/shared/', path.join(ROOT, 'src', 'shared')],
  ['/checks/', path.join(ROOT, 'checks')],
  ['/', path.join(ROOT, 'public')],
];

const FILES = {
  '/vendor/axe.min.js': require.resolve('axe-core/axe.min.js'),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Live runs keep going if the page that started them closes, and any page can follow them.
function createLiveRuns({ runLive, save, auth, pageUrl }) {
  const runs = new Map();
  const startsByDay = new Map();
  const active = new Set();

  const wake = (run) => {
    for (const resolve of run.waiters) resolve();
    run.waiters.clear();
  };

  const summary = (run) => ({ id: run.id, demoId: run.demoId, title: run.title });

  function prune() {
    const cutoff = Date.now() - KEEP_FINISHED_RUNS_MS;
    for (const [id, run] of runs) if (run.done && run.finishedAt < cutoff) runs.delete(id);
  }

  return {
    get active() {
      return [...active].map(summary);
    },

    get activeCount() {
      return active.size;
    },

    startsToday() {
      return startsByDay.get(utcDay()) ?? 0;
    },

    get(id) {
      return runs.get(id);
    },

    start(demo) {
      const run = {
        id: randomUUID(),
        demoId: demo.id,
        title: `${demo.title} demo, ${demo.tier} tier`,
        events: [],
        done: false,
        recordingId: null,
        finishedAt: null,
        controller: new AbortController(),
        waiters: new Set(),
      };
      runs.set(run.id, run);
      active.add(run);
      startsByDay.set(utcDay(), this.startsToday() + 1);

      const onEvent = (event) => {
        run.events.push(event);
        wake(run);
      };
      run.completion = Promise.resolve()
        .then(() => runLive(demo, { pageUrl, auth, signal: run.controller.signal, onEvent }))
        .then(async (recording) => {
          await save(recording);
          run.recordingId = recording.id;
        })
        .catch((err) => {
          onEvent({ t: run.events.at(-1)?.t ?? 0, type: 'run.finished', data: { ok: false, error: err.message } });
        })
        .finally(() => {
          run.done = true;
          run.finishedAt = Date.now();
          active.delete(run);
          wake(run);
          prune();
        });

      return summary(run);
    },

    async poll(run, after, res) {
      if (run.events.length <= after && !run.done) {
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            run.waiters.delete(finish);
            res.off('close', finish);
            resolve();
          };
          const timer = setTimeout(finish, POLL_WAIT_MS);
          run.waiters.add(finish);
          res.on('close', finish);
        });
      }
      return { events: run.events.slice(after), next: run.events.length, done: run.done, recordingId: run.recordingId };
    },

    stop(run) {
      run.controller.abort();
    },

    async stopAll() {
      const stopping = [...active];
      for (const run of stopping) run.controller.abort();
      await Promise.all(stopping.map((run) => run.completion));
    },
  };
}

async function runChecksOnce(res, ctx) {
  // Everyone checks the same read-only page; share an in-flight check instead of launching more browsers.
  ctx.checking ??= Promise.resolve()
    .then(() => ctx.runChecks({ baseUrl: ctx.origin }))
    .finally(() => { ctx.checking = null; });
  try {
    sendJson(res, 200, { results: await ctx.checking });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function liveStatus(ctx) {
  return {
    enabled: ctx.auth.enabled,
    reason: ctx.auth.enabled ? null : 'Live runs are off because this server has no GitHub token.',
    concurrencyLimit: ctx.concurrencyLimit,
    activeCount: ctx.live.activeCount,
    dailyLimit: ctx.dailyLimit || null,
    remainingToday: ctx.dailyLimit ? Math.max(0, ctx.dailyLimit - ctx.live.startsToday()) : null,
  };
}

// The Host check stops DNS rebinding. POSTs must be JSON from this site, so other sites can't send them.
function rejectUnsafe(req, ctx) {
  if (!ctx.allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return 'Unknown host.';
  if (req.method !== 'POST') return null;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return 'Send a JSON body.';
  const origin = req.headers.origin;
  if (origin && !ctx.allowedOrigins.has(origin.toLowerCase())) return 'Cross-origin requests are not allowed.';
  return null;
}

async function handleApi(req, res, url, ctx) {
  const unsafe = rejectUnsafe(req, ctx);
  if (unsafe) return sendJson(res, 403, { error: unsafe });

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, { live: liveStatus(ctx), activeRuns: ctx.live.active });
  }
  if (req.method === 'GET' && url.pathname === '/api/demos') return sendJson(res, 200, { demos: DEMOS });
  if (req.method === 'GET' && url.pathname === '/api/recordings') return sendJson(res, 200, { recordings: await listRecordings() });

  const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
  if (req.method === 'GET' && recordingMatch) {
    const recording = await loadRecording(decodeURIComponent(recordingMatch[1]));
    return recording ? sendJson(res, 200, recording) : sendJson(res, 404, { error: 'Recording not found.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/live') {
    if (!ctx.auth.enabled) return sendJson(res, 503, { error: liveStatus(ctx).reason });
    const demo = findDemo((await readJson(req)).demo);
    if (!demo) return sendJson(res, 400, { error: 'Unknown demo.' });
    // Check and reserve capacity together, after reading the body, with no await between them.
    const status = liveStatus(ctx);
    if (status.remainingToday === 0) return sendJson(res, 429, { error: `This server has started its ${ctx.dailyLimit} live runs for today.` });
    if (status.activeCount >= ctx.concurrencyLimit) {
      return sendJson(res, 409, { error: `All ${ctx.concurrencyLimit} live-run slots are busy. Try again when a run finishes; replays and checks still work.` });
    }
    return sendJson(res, 202, { run: ctx.live.start(demo) });
  }

  const liveMatch = url.pathname.match(/^\/api\/live\/([0-9a-f-]{36})(\/stop)?$/);
  if (liveMatch) {
    const run = ctx.live.get(liveMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'This live run is not on the server. It may have restarted.' });
    if (req.method === 'GET' && !liveMatch[2]) {
      const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0);
      return sendJson(res, 200, await ctx.live.poll(run, after, res));
    }
    if (req.method === 'POST' && liveMatch[2]) {
      ctx.live.stop(run);
      return sendJson(res, 202, { stopping: true });
    }
  }

  if (url.pathname === '/api/checks' && req.method === 'GET') {
    return sendJson(res, 200, { checks: CHECKS.map(({ id, file, check, how, expected }) => ({ id, file, check, how, expected })) });
  }
  if (url.pathname === '/api/checks' && req.method === 'POST') return runChecksOnce(res, ctx);

  return sendJson(res, 404, { error: 'Not found.' });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  if (pathname === '/healthz') return sendText(res, 200, 'ok');
  if (pathname === '/demo-page') {
    res.writeHead(301, { Location: '/demo-page/' });
    return res.end();
  }

  let file = FILES[pathname];
  if (!file) {
    const [prefix, dir] = STATIC_DIRS.find(([p]) => pathname.startsWith(p)) ?? [];
    if (!dir) return sendText(res, 404, 'Not found');
    file = path.join(dir, decodeURIComponent(pathname.slice(prefix.length)));
    if (!isInside(file, dir)) return sendText(res, 403, 'Forbidden');
    const info = await stat(file).catch(() => null);
    if (info?.isDirectory()) file = path.join(file, 'index.html');
  }

  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function parseHosts(value) {
  return String(value ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

export async function startServer({
  port = Number(process.env.PORT) || 4173,
  host = process.env.HOST || '127.0.0.1',
  allowedHosts = parseHosts(process.env.ALLOWED_HOSTS),
  dailyLimit = Number(process.env.LIVE_RUN_DAILY_LIMIT ?? 0),
  concurrencyLimit = Number(process.env.LIVE_RUN_CONCURRENCY_LIMIT ?? 5),
  auth = liveAuth(),
  runLive = runLiveDemo,
  runChecks = async (options) => (await import('../checks/run-checks.mjs')).runChecks(options),
  save = saveRecording,
} = {}) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error('LIVE_RUN_DAILY_LIMIT must be a non-negative integer.');
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) throw new Error('LIVE_RUN_CONCURRENCY_LIMIT must be a positive integer.');
  const ctx = { checking: null, dailyLimit, concurrencyLimit, auth, runChecks };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, ctx);
      else await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err instanceof SyntaxError || err instanceof URIError ? 400 : 500, { error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  // The browser that runs the checks and the browser tools is on this machine, so it uses loopback.
  ctx.origin = `http://127.0.0.1:${actualPort}`;
  ctx.pageUrl = `${ctx.origin}/demo-page/`;
  ctx.allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, ...allowedHosts]);
  ctx.allowedOrigins = new Set([
    `http://127.0.0.1:${actualPort}`,
    `http://localhost:${actualPort}`,
    ...allowedHosts.map((h) => `https://${h}`),
  ]);
  ctx.live = createLiveRuns({ runLive, save, auth, pageUrl: ctx.pageUrl });

  return {
    origin: ctx.origin,
    pageUrl: ctx.pageUrl,
    close: async () => {
      const stopping = ctx.live.stopAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await Promise.all([stopping, ctx.checking]);
    },
  };
}

if (isMain(import.meta.url)) {
  startServer()
    .then((server) => {
      const auth = liveAuth();
      console.log(`HydraFusion demos:  ${server.origin}/`);
      console.log(`Demo page:          ${server.pageUrl}`);
      console.log(`Live runs:          ${auth.gitHubToken ? 'on, with COPILOT_GITHUB_TOKEN' : auth.useLoggedInUser ? 'on, with your signed-in account' : 'off (no GitHub token)'}`);
      console.log('Press Ctrl+C to stop.');
      const shutdown = () => server.close().then(() => process.exit(0));
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(err.code === 'EADDRINUSE' ? `Port ${err.port} is in use. Set PORT to use another one.` : err);
      process.exit(1);
    });
}
