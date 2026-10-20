# HydraFusion demos

HydraFusion is a GitHub Copilot model, in research preview, that plans each request and picks a model for each step. This app runs three prompts against a web page with accessibility problems built in, and shows which pattern HydraFusion picked, each step as it runs, and what it cost.

**Slides:** [HydraFusion and Accessibility testing](slides/hydrafusion-101.pdf)

**Live demo:** https://aka.ms/hydrafusion

## How it works

![Architecture diagram. The dashboard in your browser talks to a Node.js app, with a web server and the Copilot SDK, in an Azure Container App. The app sends the prompt to HydraFusion in GitHub Copilot, which picks a pattern and models and sends back the passes and cost. For tool calls and the accessibility checks, the app drives headless Chrome with Playwright, which tests the demo page.](docs/architecture.png)

A live run, step by step:

![Sequence diagram of a live run. You click Run live, and the dashboard asks the web server to start the demo. The server opens a new Copilot SDK session on the chosen tier, and the live runner sends the prompt and the shared demo page to HydraFusion, which picks a pattern and models. For each pass, HydraFusion sends tool calls, the browser tools test the demo page, and the results go back. HydraFusion returns the answer, route and cost. The events go to the web server, the dashboard collects them by long polling, the server saves the run for replay, and the dashboard shows the workflow, passes and cost.](docs/sequence.png)

The events reach the dashboard while the run goes, not only at the end. To edit the diagrams, open `docs/architecture.excalidraw` in Excalidraw and `docs/sequence.mmd` in any Mermaid editor.

## The demos

| Pattern | Tier | Prompt |
|---|---|---|
| Single | Default | In one sentence, what does WCAG 1.1.1 require? No tools. |
| Critique | Max | Audit this page for WCAG 2.2 AA. Don't change any files. List each problem and the rule it breaks. |
| Cascade | Default | quickly test this page with the browser tools |

HydraFusion's router picks the pattern, so a prompt doesn't always get the one next to it. Live runs spend AIU from your Copilot plan. Each demo also comes with a recorded run you can replay for free, for example if a live run takes too long.

## Run it locally

You need Node.js 22.12 or later, Google Chrome, and Copilot access. Sign in with the Copilot CLI, or set `COPILOT_GITHUB_TOKEN` to a GitHub token.

```sh
npm install
npm start                 # open http://127.0.0.1:4173/
npm run demo -- all       # or run the demos in a terminal
```

## Deploy to Azure

You need the Azure Developer CLI and the GitHub CLI, both signed in.

```sh
azd up
```

Live runs use your GitHub CLI sign-in. Anyone with the app's URL can start one, so run `azd down` when you're done.

## Demo capacity

The Azure deployment admits **five independent live runs at once**, with a **100-start daily cap**. Each run gets its own Copilot session, isolated browser and output directory, and unique recording ID. Each dashboard tab follows only the run it started, including after a reload; it does not join or stop another visitor's run. A sixth start gets a clear busy message without spending a request. Replays remain available, and simultaneous requests for the fixed accessibility checks share one in-flight check rather than launching duplicate browsers.

| Setting | Local default | Azure default |
|---|---|---|
| `LIVE_RUN_CONCURRENCY_LIMIT` | 5 | 5 (`liveRunConcurrencyLimit` in `infra/main.bicep`) |
| `LIVE_RUN_DAILY_LIMIT` | 0 (unlimited) | 100 (`liveRunDailyLimit` in `infra/main.bicep`) |
| Compute | Your machine | One warm replica, 2 vCPU / 4 GiB |

Limits and live events are in memory. New recordings are on the container's temporary disk: restarting or deploying resets the counter and loses live state and new recordings; the bundled recordings remain. Finish active demos before deploying. Do **not** increase the replica count without first moving run ownership, events, admission limits and recordings to shared storage and routing poll/stop requests to the owning worker.

HydraFusion uses the GitHub account's **Copilot service**, not Azure OpenAI or a Foundry model deployment. There is no Azure model TPM setting to raise. Copilot usage allowances and rate limits still apply across all five users, and extra container replicas do not increase them. The daily cap limits starts, not tokens or AIU spend; monitor the account's usage and keep the recorded demos available as a fallback. See [Copilot usage limits](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/usage-limits).

### Verify before the demo

`npm test` includes five-user browser tests with a fake model (no AIU). Chrome or Edge must be installed, as for the app itself.

After pushing and running `azd up`, test the real Azure endpoint:

```sh
npm run test:load -- https://your-app.azurecontainerapps.io 5
```

**This spends AIU.** It starts five independent browser-backed Critique/Cascade runs through the dashboard, verifies they overlap, rejects a sixth start without charging it, reloads a tab, replays a reference run, and requests all eight accessibility checks from each user. It requires successful model answers, separate replayable recordings, no session or dashboard errors, and a health-response p95 below three seconds. The command prints timings and AIU usage as JSON and stops its unfinished runs on failure. Run it when no visitors have active runs, with the user count equal to the deployed concurrency limit.
