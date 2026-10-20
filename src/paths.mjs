import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS_DIR = path.join(ROOT, 'runs');
export const RECORDINGS_DIR = path.join(ROOT, 'recordings');
export const DEMO_PAGE_DIR = path.join(ROOT, 'demo-page');

export function isInside(target, dir) {
  const relative = path.relative(dir, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// True when the module at metaUrl is the script Node was started with.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  return normalize(path.resolve(process.argv[1])) === normalize(fileURLToPath(metaUrl));
}
