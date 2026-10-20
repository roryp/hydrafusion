# HydraFusion demos

HydraFusion is a research preview in GitHub Copilot. For each request it plans the steps and picks a model for each one, using one of three patterns:

| Pattern | Passes | What happens |
|---|---|---|
| **Single** | Main | One model does the whole job. |
| **Critique** | First, Critique, Revision | A solver drafts, a read-only critic reviews, and the same solver revises if the critic asks. |
| **Cascade** | Main, Review, Fix-up | A solver answers, a read-only judge scores it, and a stronger model repairs it only if it fails. |

This app sends one prompt for each pattern to HydraFusion through the [Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk), against a demo page with accessibility problems built in. It shows the workflow HydraFusion picked, each pass as it runs, and what the run cost, in AI Units (AIU) and premium requests. The router decides the pattern, so a prompt doesn't always get the pattern on its card.

## What's in it

| Path | What it is |
|---|---|
| `public/` | The dashboard: how HydraFusion works, the three demos, live runs and replays, and cost tables |
| `demo-page/` | A page with accessibility problems built in: contrast, headings, alt text, labels, keyboard, reflow and motion |
| `checks/` | Eight Playwright snippets that find those problems, plus `run-checks.mjs` to run them all |
| `src/live.mjs` | Runs a demo against HydraFusion and records every routing, pass and billing event |
| `src/server.mjs` | Serves the dashboard and the demo page, and runs live runs in the background |
| `src/cli.mjs` | Runs or replays the demos in a terminal |
| `recordings/reference-runs.json` | One reference run of each pattern, for replays that cost nothing |
| `recordings/live/` | A recorded live run of each demo, from the Azure deployment |
| `infra/`, `azure.yaml`, `Dockerfile` | Deployment to Azure Container Apps with the Azure Developer CLI |

## Run it on your machine

You need Node.js 22.12 or later, Chrome or Edge, and a GitHub account with Copilot access to HydraFusion. Sign in once with the Copilot CLI (`copilot`, then `/login`), or set `COPILOT_GITHUB_TOKEN` to a GitHub token.

```sh
npm install
npm start            # dashboard at http://127.0.0.1:4173/
```

In a terminal instead:

```sh
npm run demo -- single                        # run one demo live (spends AIU)
npm run demo -- all                           # run all three live
npm run demo -- cascade --replay reference    # replay the reference run (no AIU)
npm run demo -- single --replay last          # replay your last live run (no AIU)
npm run checks                                # run the accessibility snippets on the demo page
npm test
```

Live runs are saved to `runs/`. Each one starts a new session, the way you'd open a new chat for each test.

## Deploy to Azure

You need the [Azure Developer CLI](https://aka.ms/azd) and the [GitHub CLI](https://cli.github.com/), signed in with `azd auth login` and `gh auth login`.

```sh
azd up
```

It creates a resource group with Azure Container Apps (one replica, 2 vCPU, 4 GiB), Azure Container Registry, a managed identity that pulls the image, and a Log Analytics workspace. The image is built in the registry, so you don't need Docker.

Before provisioning, a hook (`infra/hooks/preprovision.mjs`) sets **`COPILOT_GITHUB_TOKEN`** in the azd environment to your GitHub CLI token, from `gh auth token`. The container app keeps it as a secret, and live runs use it to sign in to Copilot, so they spend AIU from that account's Copilot plan. The hook refreshes it on every `azd provision`. To use a fine-grained token with only Copilot access instead, run `azd env set COPILOT_GITHUB_TOKEN github_pat_...`. The hook keeps a token that starts with `github_pat_`.

Anyone with the app's URL can start live runs, so share it with care. The app starts at most 20 live runs per UTC day; change `liveRunDailyLimit` in `infra/main.bicep` to adjust that.

The app ships with a recorded live run of each demo in `recordings/live/`, so "Replay last live run" works from the start. New live runs are kept in the container until it restarts or you deploy again. While a live run is going, you can replay a recorded run and then go back to the live one.

To turn live runs off, run `azd env set COPILOT_GITHUB_TOKEN ""` and `azd provision`. To delete everything, run `azd down`.

## How a live run works

1. A new Copilot SDK session starts on `hydrafusion` (Default tier) or `hydrafusion-max` (Max tier). HydraFusion is a research preview, so the session turns on its feature flags. The service still decides whether your account can use it.
2. For the page demos, the session gets the demo page as shared context, and the browser tools from [Playwright MCP](https://github.com/microsoft/playwright-mcp), which match the browser tools built into VS Code.
3. The session is read-only: the browser tools and file reads inside the project are allowed, and shell commands, file edits and web requests are refused. The browser tools run without any of the app's secrets in their environment.
4. The SDK's `session.fusion_*` and `assistant.fusion_phase_*` events give the route, the router's scores, each pass with its model and reasoning effort, review verdicts and handoffs. `assistant.usage` events give the billing details for each model call, by token type.

In the dashboard, a live run keeps going on the server even if you close the page, and reopening the page picks it up again.

## How cost is counted

- **Premium requests** (legacy) count per prompt. Each model has a multiplier, so one pass can count 1 or 15.
- **AIU** counts every token. Each model has its own prices per million tokens; output costs 5 times new input, writing to the cache 1.25 times, and reading from the cache 0.05 to 0.1 times. Logs record cost in nano-AIU, and a billion nano-AIU make one AIU.

Critique and Cascade add review passes, which run in a separate, read-only history, so they don't add to later requests. A Cascade repair brings in a stronger model, so it can cost much more, and you pay for the rejected answer too.

The reference runs used the same prompt, "quickly test this page with the browser tools", on the demo page:

| Run | Passes | AIU | Premium requests |
|---|---|---|---|
| Critique, Max | GPT-5.6 Luna drafts, GPT-5.6 Terra critiques | 1.2 | 2 |
| Cascade, Default | GPT-6.1 Sol answers, GPT-6 Luna fails it, Claude Opus 5.5 repairs it | 285 | 21 |
| Single, Max | GPT-6 Astra does the whole job | 74 | 1 |

Models, prices and routing change over time, so your runs will differ.

## The accessibility checks

Each snippet in `checks/` is the body of an async function with `page` in scope, which is what VS Code's Run Playwright Code tool runs. You can paste one into chat as it is.

| Check | How | On the demo page |
|---|---|---|
| Contrast | Works out the ratio from colors | 1.14:1, white on light gray |
| Language, landmarks | Looks for `lang` and `main` | Both are missing |
| Heading order | Lists the headings in order | H3, then H1, then H2 |
| Keyboard | Presses Tab and notes each stop | A, INPUT, INPUT, INPUT, TEXTAREA, DIV first; three stops are divs, not buttons |
| Reflow | Resizes to 320 px wide | Scrolls sideways, 348 px wide |
| Motion | Turns on reduced motion | The blinking text keeps going |
| Names and roles | Reads the accessibility tree | An image and a field with no name |
| axe-core | Loads axe and runs it | Flags contrast, lang, alt and labels |

Use these as a first pass, then run axe-core and Accessibility Insights, keep accessibility checks in CI, test with a keyboard and a screen reader, and check that alt text makes sense.

## Notes

- `npm install` records whatever registry you use in `package-lock.json`. If that's a private mirror, run `npm run lockfile:public` before you commit, so builds elsewhere can install. The container build does this too.
- The project's `.npmrc` clears any `os` override, so npm installs native binaries for the platform you're on.
