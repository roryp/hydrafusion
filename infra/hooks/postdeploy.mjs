// azd runs this after it deploys the app, and prints the dashboard link.
// Anyone with the link can start live runs, which spend AIU from the token's Copilot plan.
const url = process.env.WEB_URL;
const liveRuns = process.env.LIVE_RUNS_ENABLED === 'true';

if (!url) {
  console.log('The app URL is not in the azd environment yet. Run "azd env refresh" and try again.');
} else {
  console.log(`\nHydraFusion demos: ${url}/`);
  console.log(liveRuns
    ? 'Live runs are on. Anyone with this link can start them, and they spend AIU from your Copilot plan.'
    : 'Live runs are off because the app has no GitHub token. Replays and checks still work.');
}
