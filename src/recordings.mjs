// Live runs are saved to runs/ so you can replay them later without spending AIU.
// recordings/reference-runs.json holds one reference run of each pattern.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RECORDINGS_DIR, RUNS_DIR } from './paths.mjs';
import { buildTrace, costRows, currentPattern, totals } from './shared/trace.mjs';

const REFERENCE_FILE = path.join(RECORDINGS_DIR, 'reference-runs.json');
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export async function loadReferenceRecordings() {
  const { recordings } = JSON.parse(await readFile(REFERENCE_FILE, 'utf8'));
  return recordings;
}

async function loadLiveRecordings() {
  let files = [];
  try {
    files = (await readdir(RUNS_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const recordings = [];
  for (const file of files) {
    try {
      recordings.push(JSON.parse(await readFile(path.join(RUNS_DIR, file), 'utf8')));
    } catch {
      // Skip files that aren't recordings.
    }
  }
  return recordings.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
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
  try {
    return JSON.parse(await readFile(path.join(RUNS_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
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
