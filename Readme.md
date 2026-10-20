# HydraFusion demos

HydraFusion is a GitHub Copilot model, in research preview, that plans each request and picks a model for each step. This app runs three prompts against a web page with accessibility problems built in, and shows which pattern HydraFusion picked, each step as it runs, and what it cost.

**Slides:** [HydraFusion and Accessibility testing](slides/hydrafusion-101.pdf)

## How it works

![Architecture diagram. Your browser shows the dashboard, served by a web server in one Azure Container App. When you run a demo, the server starts a Copilot SDK session on HydraFusion in GitHub Copilot, which picks a pattern and a model for each pass. The passes test the demo page through Playwright MCP and headless Chrome. The route, passes and cost stream back to the dashboard, and each run is saved for replay. The accessibility checks test the same page without AI.](docs/architecture.png)

To edit the diagram, open `docs/architecture.excalidraw` in Excalidraw.

A live run, step by step:

```mermaid
sequenceDiagram
    actor You
    participant D as Dashboard
    participant S as Web server
    participant R as Live runner (Copilot SDK)
    participant H as HydraFusion (GitHub Copilot)
    participant B as Browser tools (Playwright MCP)

    You->>D: Run live
    D->>S: Start the demo
    S->>R: New session on the chosen tier
    R->>H: Prompt and the shared demo page
    H->>H: Pick a pattern and a model for each pass
    loop Each pass
        H->>R: Tool calls, if the pass needs them
        R->>B: Test the demo page
        B-->>R: Results
        R-->>H: Results
    end
    H-->>R: Answer, route and cost
    R-->>S: Events for the route, each pass and its cost
    S-->>D: Events, as the dashboard asks for them
    S->>S: Save the run for replay
    D-->>You: Workflow, passes and cost
```

The events reach the dashboard while the run goes, not only at the end.

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
