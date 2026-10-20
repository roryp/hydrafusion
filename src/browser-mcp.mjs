// Starts Playwright MCP, the browser tools for live runs, with every secret removed from its
// environment, so neither the browser nor the model can read one.
import { createRequire } from 'node:module';
import path from 'node:path';
import { SECRET_ENV_VARS } from './secrets.mjs';

for (const name of SECRET_ENV_VARS) delete process.env[name];

const require = createRequire(import.meta.url);
require(path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
