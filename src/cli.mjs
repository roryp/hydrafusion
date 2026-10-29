// npm run demo -- <single|critique|cascade|all> [--replay [reference|last]] [--speed <n>]

import path from 'node:path';
import { DEMOS, findDemo } from './shared/demos.mjs';
import { runLiveDemo } from './live.mjs';
import { ROOT } from './paths.mjs';
import { latestLiveRecording, loadReferenceRecordings, saveRecording } from './recordings.mjs';
import { startServer } from './server.mjs';
import { createPrinter } from './terminal.mjs';

const USAGE = `Usage: npm run demo -- <single|critique|cascade|all> [--replay [reference|last]] [--speed <n>]

  Without --replay, each demo runs live against GitHub Copilot Fusion in a new session and spends AIU.
  Live runs are saved to runs/ so you can replay them later.

  --replay reference   replay the reference run of that pattern (no AIU)
  --replay last        replay your last saved live run of that demo (no AIU)
  --speed <n>          replay speed (default 4)`;

function parseArgs(argv) {
  const options = { demos: [], replay: null, speed: 4 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--replay') {
      options.replay = ['reference', 'last'].includes(argv[i + 1]) ? argv[++i] : 'reference';
    } else if (arg === '--speed') {
      options.speed = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === 'all') {
      options.demos.push(...DEMOS);
    } else if (findDemo(arg)) {
      options.demos.push(findDemo(arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.speed) || options.speed <= 0) throw new Error('--speed needs a positive number');
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function replay(recording, speed) {
  const print = createPrinter();
  let previous = 0;
  for (const event of recording.events) {
    await sleep(Math.min(2000, Math.max(0, event.t - previous) / speed));
    previous = event.t;
    print(event.type === 'run.started' ? { ...event, data: { ...event.data, replay: true } } : event);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help || !options.demos.length) {
    console.log(USAGE);
    return;
  }

  if (options.replay) {
    const reference = await loadReferenceRecordings();
    for (const demo of options.demos) {
      const recording = options.replay === 'reference'
        ? reference.find((item) => item.demoId === demo.id)
        : await latestLiveRecording(demo.id);
      if (!recording) {
        console.log(`\nNo saved live run of the ${demo.title} demo yet. Run "npm run demo -- ${demo.id}" first.`);
        continue;
      }
      await replay(recording, options.speed);
    }
    return;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nStopping the run...');
    controller.abort();
  });

  // Serves the demo page so the browser tools can open it.
  const server = await startServer({ port: 0 });
  let failed = false;
  try {
    for (const demo of options.demos) {
      if (controller.signal.aborted) break;
      const recording = await runLiveDemo(demo, { pageUrl: server.pageUrl, onEvent: createPrinter(), signal: controller.signal });
      const file = await saveRecording(recording);
      console.log(`\nSaved ${path.relative(ROOT, file)}. Replay it with: npm run demo -- ${demo.id} --replay last`);
      failed ||= !recording.events.some((e) => e.type === 'run.finished' && e.data.ok);
    }
  } finally {
    await server.close();
  }
  if (failed) process.exitCode = 1;
}

main()
  .then(() => {
    // A browser process that won't quit shouldn't keep the CLI open once everything is saved.
    setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
