// Points every "resolved" URL in package-lock.json at the public npm registry.
// npm records whichever registry it installed from, and a private mirror breaks installs anywhere else,
// such as the container build. npm still uses your configured registry when you install locally.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'package-lock.json';
const lock = JSON.parse(readFileSync(file, 'utf8'));
let changed = 0;

for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!key || entry.link || !entry.resolved || !entry.version) continue;
  const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const url = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${entry.version}.tgz`;
  if (entry.resolved !== url) {
    entry.resolved = url;
    changed++;
  }
}

writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`${file}: ${changed} package(s) now resolve from registry.npmjs.org.`);
