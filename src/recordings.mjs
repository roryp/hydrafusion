// Live runs are saved to runs/ so you can replay them later without spending AIU.
// recordings/reference-runs.json holds one reference run of each pattern, and recordings/live/
// holds recorded live runs of the three demos, which ship with the app so they're always there.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RECORDINGS_DIR, RUNS_DIR } from './paths.mjs';
import { buildTrace, costRows, currentPattern, totals } from './shared/trace.mjs';

const REFERENCE_FILE = path.join(RECORDINGS_DIR, 'reference-runs.json');
const LIVE_DIRS = [RUNS_DIR, path.join(RECORDINGS_DIR, 'live')];
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export async function loadReferenceRecordings() {
  const { recordings } = JSON.parse(await readFile(REFERENCE_FILE, 'utf8'));
  return recordings;
}

async function readRecordings(dir) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const recordings = [];
  for (const file of files) {
    try {
      recordings.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
    } catch {
      // Skip files that aren't recordings.
    }
  }
  return recordings;
}

async function loadLiveRecordings() {
  const recordings = (await Promise.all(LIVE_DIRS.map(readRecordings))).flat();
  const unique = [...new Map(recordings.map((recording) => [recording.id, recording])).values()];
  return unique.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

export function summarize(recording) {
  const trace = buildTrace(recording.events ?? []);
  const sum = totals(trace);
  return {
    id: recording.id,
    title: recording.title,
    source: recording.source,
    demoId: recording.demoId,
    tier: trace.meta?.tier ?? null,
    prompt: trace.meta?.prompt ?? null,
    pattern: currentPattern(trace),
    aiu: sum.reportedAiu ?? sum.aiu,
    premium: sum.premium,
    durationMs: sum.durationMs,
    status: trace.status,
    error: trace.error,
    savedAt: recording.savedAt ?? null,
    rows: costRows(trace).map(({ pass, model, modelName, effort, prices, premium, aiu }) => ({ pass, model, modelName, effort, prices, premium, aiu })),
  };
}

export async function listRecordings() {
  const [reference, live] = await Promise.all([loadReferenceRecordings(), loadLiveRecordings()]);
  return [...reference, ...live].map(summarize);
}

export async function loadRecording(id) {
  if (!SAFE_ID.test(id)) return null;
  const reference = (await loadReferenceRecordings()).find((recording) => recording.id === id);
  if (reference) return reference;
  for (const dir of LIVE_DIRS) {
    try {
      return JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

export async function latestLiveRecording(demoId) {
  return (await loadLiveRecordings()).find((recording) => recording.demoId === demoId && recording.events?.some((e) => e.type === 'run.finished' && e.data?.ok)) ?? null;
}

export async function saveRecording(recording) {
  await mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${recording.id}.json`);
  await writeFile(file, JSON.stringify(recording, null, 2) + '\n', 'utf8');
  return file;
}
