// azd runs this before it provisions Azure resources. It sets COPILOT_GITHUB_TOKEN in the azd
// environment to the GitHub CLI's token (gh auth token), so live runs work with no extra setup.
// A fine-grained token you set yourself (github_pat_...) is kept. The token is never printed.
import { execFileSync } from 'node:child_process';

const onWindows = process.platform === 'win32';

function setAzdValue(name, value) {
  execFileSync('azd', ['env', 'set', name, value], { shell: onWindows, stdio: ['ignore', 'ignore', 'inherit'] });
}

function gitHubCliToken() {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      shell: onWindows,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[A-Za-z0-9_]+$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

const current = process.env.COPILOT_GITHUB_TOKEN?.trim() || '';

if (current.startsWith('github_pat_')) {
  console.log('Live runs: using the fine-grained token already in COPILOT_GITHUB_TOKEN.');
} else {
  const token = gitHubCliToken();
  if (token) {
    if (token !== current) setAzdValue('COPILOT_GITHUB_TOKEN', token);
    console.log('Live runs: using your GitHub CLI sign-in (gh auth token).');
  } else if (current) {
    console.log('Live runs: the GitHub CLI has no token, so the one already in COPILOT_GITHUB_TOKEN is kept.');
  } else {
    console.warn('Live runs will be off: the GitHub CLI has no token. Run "gh auth login", then "azd provision" to turn them on.');
  }
}
