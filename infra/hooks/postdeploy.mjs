// azd runs this after it deploys the app, and prints the dashboard link.
// Audience access is replay-only; new runs and checks require GitHub admin sign-in.
const url = process.env.WEB_URL;
const liveRuns = process.env.LIVE_RUNS_ENABLED === 'true';
const gitHubSignIn = !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);

if (!url) {
  console.log('The app URL is not in the azd environment yet. Run "azd env refresh" and try again.');
} else {
  console.log(`\nGitHub Copilot Fusion demos: ${url}/`);
  console.log(!gitHubSignIn
    ? 'The dashboard is replay-only. Configure GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to enable admin sign-in.'
    : liveRuns
      ? 'Audience access is replay-only. The GitHub admin can start live runs and checks; live runs spend AIU from your Copilot plan.'
      : 'Audience access is replay-only. The GitHub admin can run checks; live runs are off because the app has no GitHub token.');
}
