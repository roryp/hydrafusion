// Serves the dashboard, the demo page and a small JSON API:
//   GET  /api/config              what this server allows, and the live run in progress, if any
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
//   LIVE_RUN_KEY            if set, starting or stopping a live run needs this key
//   LIVE_RUN_DAILY_LIMIT    most live runs to start per UTC day (0 means no limit)

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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

function sameSecret(given, expected) {
  const digest = (value) => createHash('sha256').update(String(value ?? '')).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Live runs keep going if the page that started them closes, and any page can follow them.
function createLiveRuns({ runLive, save, auth, pageUrl }) {
  const runs = new Map();
  const startsByDay = new Map();
  let active = null;

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
      return active ? summary(active) : null;
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
      active = run;
      startsByDay.set(utcDay(), this.startsToday() + 1);

      const onEvent = (event) => {
        run.events.push(event);
        wake(run);
      };
      Promise.resolve()
        .then(() => runLive(demo, { pageUrl, auth, signal: run.controller.signal, onEvent }))
        .then(async (recording) => {
          await save(recording);
          run.recordingId = recording.id;
        })
        .catch((err) => {
          if (!run.events.some((event) => event.type === 'run.finished')) {
            onEvent({ t: run.events.at(-1)?.t ?? 0, type: 'run.finished', data: { ok: false, error: err.message } });
          }
        })
        .finally(() => {
          run.done = true;
          run.finishedAt = Date.now();
          if (active === run) active = null;
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
  };
}

async function runChecksOnce(res, ctx) {
  if (ctx.checking) return sendJson(res, 409, { error: 'The checks are already running.' });
  ctx.checking = true;
  try {
    const { runChecks } = await import('../checks/run-checks.mjs');
    sendJson(res, 200, { results: await runChecks({ baseUrl: ctx.origin }) });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  } finally {
    ctx.checking = false;
  }
}

function liveStatus(req, ctx) {
  const keyAccepted = ctx.liveRunKey ? sameSecret(req.headers['x-live-key'], ctx.liveRunKey) : true;
  return {
    enabled: ctx.auth.enabled,
    reason: ctx.auth.enabled ? null : 'Live runs are off because this server has no GitHub token.',
    needsKey: !!ctx.liveRunKey,
    keyAccepted,
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
    return sendJson(res, 200, { live: liveStatus(req, ctx), activeRun: ctx.live.active });
  }
  if (req.method === 'GET' && url.pathname === '/api/demos') return sendJson(res, 200, { demos: DEMOS });
  if (req.method === 'GET' && url.pathname === '/api/recordings') return sendJson(res, 200, { recordings: await listRecordings() });

  const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
  if (req.method === 'GET' && recordingMatch) {
    const recording = await loadRecording(decodeURIComponent(recordingMatch[1]));
    return recording ? sendJson(res, 200, recording) : sendJson(res, 404, { error: 'Recording not found.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/live') {
    const status = liveStatus(req, ctx);
    if (!status.enabled) return sendJson(res, 503, { error: status.reason });
    if (!status.keyAccepted) return sendJson(res, 403, { error: 'Live runs on this server need the access key.' });
    const demo = findDemo((await readJson(req)).demo);
    if (!demo) return sendJson(res, 400, { error: 'Unknown demo.' });
    if (ctx.live.active) return sendJson(res, 409, { error: 'Another live run is in progress.', activeRun: ctx.live.active });
    if (status.remainingToday === 0) return sendJson(res, 429, { error: `This server has started its ${ctx.dailyLimit} live runs for today.` });
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
      if (!liveStatus(req, ctx).keyAccepted) return sendJson(res, 403, { error: 'Stopping a live run needs the access key.' });
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
    // The dashboard link can carry the live-run key, so it is never sent on as a referrer.
    'Referrer-Policy': 'no-referrer',
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
  liveRunKey = process.env.LIVE_RUN_KEY || null,
  dailyLimit = Number(process.env.LIVE_RUN_DAILY_LIMIT) || 0,
  auth = liveAuth(),
  runLive = runLiveDemo,
  save = saveRecording,
} = {}) {
  const ctx = { checking: false, liveRunKey, dailyLimit, auth };

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
    close: () => new Promise((resolve) => {
      const active = ctx.live.active;
      if (active) ctx.live.stop(ctx.live.get(active.id));
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
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
