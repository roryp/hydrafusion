// azd runs this after it deploys the app. It prints the dashboard link, including the access
// key for live runs. Anyone with that link can spend AIU from the token's Copilot plan, so share it with care.
const url = process.env.WEB_URL;
const key = process.env.LIVE_RUN_KEY;
const liveRuns = process.env.LIVE_RUNS_ENABLED === 'true';

if (!url) {
  console.log('The app URL is not in the azd environment yet. Run "azd env refresh" and try again.');
} else {
  console.log(`\nHydraFusion demos: ${url}/`);
  if (liveRuns && key) {
    console.log(`To run demos live, open this link once in your browser (it stores the access key):\n  ${url}/?key=${key}`);
  } else {
    console.log('Live runs are off because the app has no GitHub token. Replays and checks still work.');
  }
}
