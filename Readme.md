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
