// npm run screenshots: retakes the screenshots on the tutorials page, in public/images/tutorial/.
// It replays recordings and runs the fixed checks. For the live-run screenshot, a stand-in plays a
// recorded live run into the live view, so no Copilot session starts and no AIU is spent.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../checks/run-checks.mjs';
import { ROOT } from '../src/paths.mjs';
import { loadRecording } from '../src/recordings.mjs';
import { startServer } from '../src/server.mjs';

const OUT_DIR = path.join(ROOT, 'public', 'images', 'tutorial');
// The bundled live run of the Cascade demo: it routes, calls the browser tools and has a review pass.
const RECORDING_ID = '2026-10-20_07-59-38-cascade';
// The stand-in live run holds after this many tool calls, so the screenshot shows a run in progress.
const PAUSE_AFTER_TOOL_CALLS = 8;
const SCALE = 2;

function recordedLiveRun(recording) {
  return async (demo, { signal, onEvent }) => {
    const events = [];
    const emit = (event) => {
      events.push(event);
      onEvent(event);
    };
    let toolCalls = 0;
    for (const event of recording.events) {
      if (event.type === 'run.finished') break;
      if (event.type === 'tool.execution_start' && ++toolCalls > PAUSE_AFTER_TOOL_CALLS) break;
      emit(event.type === 'run.started' ? { ...event, data: { ...event.data, startedAt: new Date().toISOString() } } : event);
    }
    await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })));
    emit({ t: events.at(-1).t, type: 'run.finished', data: { ok: false, error: 'Stopped.' } });
    return { id: `stand-in-${Date.now()}`, title: recording.title, source: 'live', demoId: demo.id, events };
  };
}

// Screenshots the area that covers every selector, plus some padding, at the device scale.
async function shoot(page, name, selectors, pad = 16) {
  const clip = await page.evaluate(([list, padding]) => {
    const boxes = list.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Nothing matches ${selector}`);
      return el.getBoundingClientRect();
    });
    const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) + scrollX - padding);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) + scrollY - padding);
    const right = Math.min(document.documentElement.scrollWidth, Math.max(...boxes.map((b) => b.right)) + scrollX + padding);
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + scrollY + padding;
    return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
  }, [selectors, pad]);
  const png = await page.screenshot({ fullPage: true, clip, animations: 'disabled', caret: 'hide' });
  await writeFile(path.join(OUT_DIR, name), png);
  console.log(`${name}: ${png.readUInt32BE(16) / SCALE} x ${png.readUInt32BE(20) / SCALE}`);
}

const badge = (page, text) => page.locator('#viewer [data-role="badge"]').filter({ hasText: new RegExp(`^${text}$`) }).waitFor();

const recording = await loadRecording(RECORDING_ID);
if (!recording) throw new Error(`Recording ${RECORDING_ID} not found.`);
await mkdir(OUT_DIR, { recursive: true });

const server = await startServer({ port: 0, auth: { enabled: true }, runLive: recordedLiveRun(recording), save: async () => {} });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SCALE, reducedMotion: 'reduce' });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(server.origin);
  await page.locator('[data-demo="cascade"] [data-action="last"]:enabled').waitFor();

  await page.locator('[data-demo="cascade"] [data-action="last"]').click();
  await page.getByRole('button', { name: 'Skip to the end', exact: true }).click();
  await badge(page, 'Finished');
  await shoot(page, 'replay-finished.png', ['#viewer .viewer-head', '#viewer .passes']);
  await shoot(page, 'browser-tools.png', ['#viewer .passes > li:first-child'], 8);

  await page.locator('#run-details > summary').click();
  await shoot(page, 'routing.png', ['#run-details .flow']);

  await page.getByRole('button', { name: 'Run the checks', exact: true }).click();
  await page.waitForFunction(() => /^\d+ of \d+ checks/.test(document.querySelector('#checks-status').textContent), null, { timeout: 120_000 });
  await shoot(page, 'checks.png', ['#testing-title', '#testing .table-scroll']);

  // A fresh page, so the viewer shows only the live run.
  await page.goto(server.origin);
  await page.locator('[data-demo="cascade"] [data-action="live"]:enabled').waitFor();
  await page.locator('[data-demo="cascade"] [data-action="live"]').click();
  await page.getByRole('button', { name: 'Stop the run', exact: true }).waitFor();
  await page.waitForFunction((n) => document.querySelectorAll('#viewer .tool-list li').length >= n, PAUSE_AFTER_TOOL_CALLS);
  await shoot(page, 'live-run.png', ['#viewer .viewer-head', '#viewer .passes']);
  await page.getByRole('button', { name: 'Stop the run', exact: true }).click();
  await badge(page, 'Ended with an error');
} finally {
  await browser.close();
  await server.close();
}
