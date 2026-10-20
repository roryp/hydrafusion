import { CHECKS } from '/shared/checks.mjs';
import { DEMOS, PATTERNS, TOKEN_TYPES, patternName } from '/shared/demos.mjs';
import {
  NANO_PER_AIU,
  applyEvent,
  costRows,
  createTrace,
  currentPattern,
  effortsFromRule,
  finalAnswer,
  formatAiu,
  formatDuration,
  formatNumber,
  formatPrices,
  formatScores,
  isFinished,
  modelName,
  phaseEffort,
  pipeline,
  reviewSummary,
  selectedWorkflow,
  toolsForPhase,
  totals,
} from '/shared/trace.mjs';

// Long runs are replayed faster so a replay takes about this long.
const REPLAY_TARGET_MS = 20_000;

const STATE_LABELS = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Not needed',
  'not-run': 'Did not run',
};

// Price per token compared with new input. Bar widths are relative to output (5×).
const RELATIVE_PRICE = { cache_read: 0.1, input: 1, cache_write: 1.25, output: 5 };

// The viewer has two views, so you can replay a recorded run while a live run keeps going.
const state = {
  views: { live: null, replay: null },
  showing: null,
  live: null,
  replay: null,
  recordings: [],
  checking: false,
  config: null,
  liveMessage: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? '');
const plural = (n, singular, pluralForm = `${singular}s`) => `${n} ${n === 1 ? singular : pluralForm}`;

function currentView() {
  return state.showing ? state.views[state.showing] : null;
}

function shownTrace() {
  return currentView()?.trace ?? null;
}

function liveInProgress() {
  return !!state.live && !!state.views.live && !isFinished(state.views.live.trace);
}

function announce(message) {
  const region = $('#announcer');
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 60);
}

let frame = 0;
function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render() {
  renderFlow();
  renderPatternStates();
  renderTokenPrices();
  renderCards();
  renderViewer();
}

// Server settings and the live-run note

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    state.config = await res.json();
  } catch {
    state.config = null;
  }
  renderLiveNote();
  renderCards();
  const active = state.config?.activeRun;
  if (active && !state.live) followRun(active);
}

function canStartLive() {
  const live = state.config?.live;
  return !!live?.enabled && live.remainingToday !== 0 && !state.live;
}

function renderLiveNote() {
  const note = $('#live-note');
  const live = state.config?.live;
  let text;
  if (state.liveMessage) text = state.liveMessage;
  else if (!live) text = 'Couldn’t reach the server.';
  else if (!live.enabled) text = `${live.reason} Replays and checks still work.`;
  else if (live.remainingToday === 0) text = `This server has started its ${live.dailyLimit} live runs for today. Replays and checks still work.`;
  else {
    text = 'Live runs spend AIU from the Copilot plan of the GitHub account this server uses. While one runs, you can replay a recorded run and come back to it.';
    if (live.remainingToday != null) text += ` ${plural(live.remainingToday, 'live run')} left today.`;
  }
  note.textContent = text;
}

function showLiveMessage(message) {
  state.liveMessage = message;
  renderLiveNote();
  announce(message);
}

// The request, router and plan boxes

function stepEffort(trace, step) {
  return step.phase ? phaseEffort(trace, step.phase) : effortsFromRule(trace.plan)[step.kind] ?? null;
}

function renderFlow() {
  const trace = shownTrace();
  const request = $('[data-slot="request"]');
  const router = $('[data-slot="router"]');
  const plan = $('[data-slot="plan"]');
  if (!trace?.meta) {
    request.replaceChildren();
    router.replaceChildren();
    plan.replaceChildren();
    return;
  }

  request.replaceChildren(
    h('p', { class: 'quote' }, `“${trace.meta.prompt}”`),
    h('span', { class: 'muted' }, `${trace.meta.tier} tier (${trace.meta.model})`),
  );

  const scores = formatScores(trace.plan?.scores);
  if (trace.route?.failed) {
    router.replaceChildren(h('p', {}, `Routing failed (${trace.route.failed.reason}). It carried on with ${modelName(trace, trace.route.failed.fallbackModel)}.`));
  } else if (scores) {
    router.replaceChildren(
      h('dl', { class: 'scores' }, scores.map((s) => [
        h('dt', {}, s.label),
        h('dd', {},
          h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(Math.min(1, Math.max(0, s.value)) * 100)}%` })),
          h('span', {}, s.value.toFixed(2))),
      ])),
      h('p', { class: 'muted' }, [
        trace.route?.latencyMs != null ? `Routed in ${formatDuration(trace.route.latencyMs)}` : null,
        trace.route?.policy ? `${trace.route.policy} policy` : null,
      ].filter(Boolean).join(', ')),
    );
  } else if (trace.plan) {
    router.replaceChildren(h('p', { class: 'muted' }, 'This run didn’t record the router’s scores.'));
  } else {
    router.replaceChildren(h('p', { class: 'muted' }, trace.status === 'routing' ? 'Scoring the request…' : 'Waiting for the route…'));
  }

  const pattern = currentPattern(trace);
  plan.replaceChildren(...(pattern
    ? [
        h('p', {}, h('strong', {}, patternName(pattern))),
        h('ol', { class: 'plan-steps' }, pipeline(trace).map((step) => {
          const effort = stepEffort(trace, step);
          return h('li', {}, `${step.pass}: ${step.model ? modelName(trace, step.model) : '—'}${effort ? `, ${effort} effort` : ''}${step.conditional ? ' (if needed)' : ''}`);
        })),
      ]
    : []));
}

// The three patterns

function buildPatternRows() {
  $('#pattern-rows').replaceChildren(...Object.entries(PATTERNS).map(([key, pattern]) =>
    h('div', { class: 'pattern-row', 'data-pattern': key },
      h('h3', {}, pattern.name),
      h('ol', { class: 'steps', 'aria-label': `${pattern.name} steps` }, pattern.steps.map((step) =>
        h('li', {},
          h('div', { class: `step${step.conditional ? ' conditional' : ''}`, 'data-kind': step.kind, 'data-conditional': step.conditional ? '1' : '' },
            h('strong', {}, step.title),
            h('span', { class: 'detail' }, step.detail),
            h('span', { class: 'live' }))))))));
}

function renderPatternStates() {
  const trace = shownTrace();
  const pattern = trace ? currentPattern(trace) : null;
  const steps = pattern ? pipeline(trace) : [];
  for (const row of document.querySelectorAll('.pattern-row')) {
    const active = row.dataset.pattern === pattern;
    row.classList.toggle('active', active);
    for (const box of row.querySelectorAll('.step')) {
      const step = active ? steps.find((s) => s.kind === box.dataset.kind) : null;
      box.className = `step${box.dataset.conditional ? ' conditional' : ''}${step ? ` state-${step.state}` : ''}`;
      $('.live', box).textContent = step
        ? [step.model ? modelName(trace, step.model) : null, STATE_LABELS[step.state]].filter(Boolean).join(' · ')
        : '';
    }
  }
}

// How tokens are priced

function buildTokenPrices() {
  $('#token-prices').replaceChildren(...TOKEN_TYPES.map((type) =>
    h('tr', { 'data-type': type.type },
      h('th', { scope: 'row' }, type.label),
      h('td', {},
        h('span', { class: 'bar-cell' },
          h('span', { class: 'price-bar', style: `width:${Math.max(4, (RELATIVE_PRICE[type.type] / 5) * 260)}px`, 'aria-hidden': 'true' }),
          type.relative)),
      h('td', { 'data-role': 'live', class: 'muted' }, '—'))));
}

function renderTokenPrices() {
  const trace = shownTrace();
  const byType = {};
  for (const call of trace?.usage ?? []) {
    for (const d of call.tokenDetails ?? []) {
      const entry = (byType[d.tokenType] ??= { tokens: 0, nano: 0 });
      entry.tokens += d.tokenCount;
      entry.nano += (d.tokenCount * d.costPerBatch) / d.batchSize;
    }
  }
  for (const row of document.querySelectorAll('#token-prices tr')) {
    const entry = byType[row.dataset.type];
    $('[data-role="live"]', row).textContent = entry
      ? `${formatNumber(entry.tokens)} tokens, ${formatAiu(entry.nano / NANO_PER_AIU)} AIU`
      : trace?.meta?.source === 'reference' ? 'Not recorded' : '—';
  }
}

// The accessibility checks

function buildChecks() {
  $('#checks-body').replaceChildren(...CHECKS.map((check) =>
    h('tr', { 'data-check': check.id },
      h('th', { scope: 'row' }, check.check),
      h('td', {}, check.how),
      h('td', {}, check.expected),
      h('td', { class: 'measured' },
        h('span', { 'data-role': 'measured', class: 'muted' }, 'Not run yet'),
        h('details', { 'data-file': check.file },
          h('summary', {}, `Show the snippet (${check.file})`),
          h('pre', {}, h('code', {}, 'Loading…')))))));

  for (const details of document.querySelectorAll('#checks-body details')) {
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded) return;
      const res = await fetch(`/checks/${details.dataset.file}`);
      $('code', details).textContent = res.ok ? await res.text() : 'Couldn’t load the snippet.';
      details.dataset.loaded = '1';
    });
  }
}

async function runChecks() {
  if (state.checking) return;
  state.checking = true;
  const button = $('#run-checks');
  const status = $('#checks-status');
  button.disabled = true;
  status.textContent = 'Running the snippets in a browser…';
  try {
    const res = await fetch('/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    for (const result of body.results) {
      const cell = $(`#checks-body tr[data-check="${result.id}"] [data-role="measured"]`);
      cell.className = result.matchesExpected ? 'match' : 'mismatch';
      cell.replaceChildren(
        result.matchesExpected ? '✔ ' : '✖ ',
        h('span', { class: 'visually-hidden' }, result.matchesExpected ? 'Found as expected: ' : 'Not as expected: '),
        result.error ? `Error: ${result.error}` : result.measured,
      );
    }
    const matches = body.results.filter((r) => r.matchesExpected).length;
    status.textContent = `${matches} of ${body.results.length} checks found the problem built into the page.`;
  } catch (err) {
    status.textContent = `The checks didn’t run: ${err.message}`;
  } finally {
    state.checking = false;
    button.disabled = false;
  }
}

// The demo cards

function buildCards() {
  $('#demo-cards').replaceChildren(...DEMOS.map((demo) =>
    h('article', { class: 'card', 'data-demo': demo.id, 'aria-labelledby': `card-${demo.id}` },
      h('h3', { id: `card-${demo.id}` }, demo.title),
      h('p', { class: 'tier' }, `${demo.tier} tier (${demo.model})`),
      h('pre', { class: 'prompt-box' }, demo.prompt),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'button', 'data-action': 'live', onclick: () => runLive(demo) },
          'Run live', h('span', { class: 'visually-hidden' }, `: ${demo.title} demo`)),
        h('button', { type: 'button', class: 'button secondary', 'data-action': 'last', onclick: () => replayLast(demo) },
          'Replay last live run', h('span', { class: 'visually-hidden' }, `: ${demo.title} demo`)),
        h('button', { type: 'button', class: 'button secondary', 'data-action': 'reference', onclick: () => replayReference(demo) },
          'Replay reference run', h('span', { class: 'visually-hidden' }, `: ${demo.title}`))),
      h('p', { class: 'last-run', 'data-role': 'last-run' }))));
}

function lastLive(demoId) {
  return state.recordings.find((r) => r.source === 'live' && r.demoId === demoId && r.status === 'done');
}

function renderCards() {
  for (const card of document.querySelectorAll('.card')) {
    const last = lastLive(card.dataset.demo);
    for (const button of card.querySelectorAll('button')) {
      const action = button.dataset.action;
      button.disabled = (action === 'live' && !canStartLive()) || (action === 'last' && !last);
    }
    $('[data-role="last-run"]', card).textContent = last
      ? `Last live run: ${patternName(last.pattern)} workflow, ${formatAiu(last.aiu)} AIU, ${formatDuration(last.durationMs)}`
      : 'No live run yet';
  }
}

// The run viewer

function startView(kind, { title, source = null }) {
  state.views[kind] = { kind, key: `${kind}-${Date.now()}`, title, source, trace: createTrace(), startedAt: Date.now() };
  showView(kind);
}

function showView(kind) {
  state.showing = kind;
  render();
  const viewer = $('#viewer');
  viewer.focus({ preventScroll: true });
  viewer.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function handleEvent(kind, event) {
  const view = state.views[kind];
  if (!view) return;
  applyEvent(view.trace, event);
  const trace = view.trace;
  if (state.showing === kind) {
    switch (event.type) {
      case 'session.fusion_resolved':
        announce(selectedWorkflow(trace));
        break;
      case 'session.fusion_route_failed':
        announce('Routing failed. It carried on with a fallback model.');
        break;
      case 'assistant.fusion_phase_started': {
        const phase = trace.phases.find((p) => p.id === event.data.phaseId);
        if (phase) announce(`${phase.pass} pass started`);
        break;
      }
      case 'run.finished': {
        const sum = totals(trace);
        announce(event.data.ok ? `Run finished: ${formatAiu(sum.reportedAiu ?? sum.aiu)} AIU.` : `The run ended: ${event.data.error ?? 'error'}`);
        break;
      }
      default:
        break;
    }
  } else if (kind === 'live' && event.type === 'run.finished') {
    announce('The live run finished. Choose “Back to the live run” to see it.');
  }
  scheduleRender();
}

function elapsedMs(view) {
  const trace = view.trace;
  if (trace.meta?.source === 'reference') return null;
  if (view.kind !== 'live' || isFinished(trace)) return trace.durationMs ?? trace.lastT;
  const started = Date.parse(trace.meta?.startedAt ?? '');
  const sinceStart = Number.isNaN(started) ? Date.now() - view.startedAt : Date.now() - started;
  return Math.max(trace.lastT, sinceStart);
}

function updateStatus() {
  const viewer = $('#viewer');
  const badge = $('[data-role="badge"]', viewer);
  const elapsed = $('[data-role="elapsed"]', viewer);
  const view = currentView();
  if (!badge || !view) return;
  const finished = isFinished(view.trace);
  badge.className = `badge ${finished ? (view.trace.status === 'done' ? 'done' : 'error') : 'live'}`;
  badge.textContent = finished
    ? (view.trace.status === 'done' ? 'Finished' : 'Ended with an error')
    : view.kind === 'live' ? (state.live?.stopping ? 'Stopping' : 'Running') : 'Replaying';
  const ms = elapsedMs(view);
  elapsed.textContent = ms != null ? formatDuration(ms) : '';
  updateControls();
}

function updateControls() {
  const slot = $('#viewer [data-role="controls"]');
  const view = currentView();
  if (!slot || !view) return;
  const buttons = [];
  if (view.kind === 'live' && liveInProgress() && !state.live.stopping) buttons.push('stop');
  if (view.kind === 'replay' && state.replay) buttons.push('skip');
  if (view.kind === 'replay' && state.views.live) buttons.push(liveInProgress() ? 'back-running' : 'back');
  const key = buttons.join(',');
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  slot.replaceChildren(...buttons.map((name) => {
    switch (name) {
      case 'stop':
        return h('button', { type: 'button', class: 'button secondary', onclick: stopLive }, 'Stop the run');
      case 'skip':
        return h('button', { type: 'button', class: 'button secondary', onclick: skipReplay }, 'Skip to the end');
      case 'back-running':
        return h('button', { type: 'button', class: 'button', onclick: () => showView('live') }, 'Back to the live run (still running)');
      default:
        return h('button', { type: 'button', class: 'button', onclick: () => showView('live') }, 'Back to the live run');
    }
  }));
}

function renderViewer() {
  const viewer = $('#viewer');
  const view = currentView();
  if (!view) return;
  if (viewer.dataset.key !== view.key) {
    viewer.dataset.key = view.key;
    const eyebrow = view.kind === 'live' ? 'Live run' : view.source === 'reference' ? 'Replay of a reference run' : 'Replay of a recorded live run';
    viewer.replaceChildren(
      h('div', { class: 'viewer-head' },
        h('div', {},
          h('p', { class: 'eyebrow' }, eyebrow),
          h('h3', { id: 'viewer-title' }, view.title)),
        h('div', { class: 'status' },
          h('span', { class: 'badge', 'data-role': 'badge' }),
          h('span', { class: 'muted', 'data-role': 'elapsed' }),
          h('span', { class: 'controls', 'data-role': 'controls' }))),
      h('div', { 'data-role': 'body' }));
  }
  updateStatus();
  $('[data-role="body"]', viewer).replaceChildren(...viewerBody(view.trace));
}

function viewerBody(trace) {
  const meta = trace.meta ?? {};
  const nodes = [];
  if (meta.prompt) nodes.push(h('p', {}, h('strong', {}, 'Prompt: '), meta.prompt));
  if (meta.tier) nodes.push(h('p', { class: 'muted' }, `${meta.tier} tier (${meta.model})${meta.pageUrl ? ', with the demo page shared' : ''}`));
  if (meta.note) nodes.push(h('p', { class: 'note' }, meta.note));

  if (trace.route?.failed) {
    nodes.push(h('p', { class: 'route-note' }, `Routing failed (${trace.route.failed.reason}). It carried on with the fallback model, ${modelName(trace, trace.route.failed.fallbackModel)}.`));
  }

  const workflow = selectedWorkflow(trace);
  const pattern = currentPattern(trace);
  if (workflow) {
    const expected = meta.expectedPattern;
    nodes.push(h('p', { class: 'workflow' }, workflow,
      expected && expected !== pattern ? [' ', h('span', { class: 'badge warn' }, `This prompt tends to get ${patternName(expected)}, but the router decides`)] : null));
    const hint = trace.plan?.hint ?? PATTERNS[pattern]?.hint;
    if (hint) nodes.push(h('p', { class: 'hint' }, hint));
  } else if (!isFinished(trace)) {
    nodes.push(h('p', { class: 'workflow muted' }, trace.status === 'routing' ? 'Routing…' : 'Starting a new session…'));
  }

  const steps = pipeline(trace);
  if (steps.length) nodes.push(h('ol', { class: 'passes', 'aria-label': 'Passes' }, steps.map((step) => passItem(trace, step))));

  if (isFinished(trace)) {
    if (trace.error) nodes.push(h('p', { class: 'error-text' }, `The run ended with an error: ${trace.error}`));
    const answer = finalAnswer(trace);
    if (answer) {
      nodes.push(h('div', { class: 'answer' },
        h('h4', {}, `Answer${answer.pass ? `, from the ${answer.pass} pass (${modelName(trace, answer.model)})` : ''}`),
        h('pre', { class: 'answer-text', tabindex: '0' }, answer.content.trim())));
    } else if (meta.source === 'reference') {
      nodes.push(h('p', { class: 'note' }, 'This reference run records models and cost, not the answer.'));
    }
    if (trace.phases.length) {
      nodes.push(h('h4', {}, 'What it cost'), costTable(costRows(trace)), totalsLine(trace));
    }
  }
  return nodes;
}

function passItem(trace, step) {
  const phase = step.phase;
  const usage = phase?.usage;
  const effort = stepEffort(trace, step);
  const about = [
    step.model ? modelName(trace, step.model) : null,
    effort ? `effort ${effort}` : null,
    step.review ? 'separate read-only history' : null,
  ].filter(Boolean).join(' · ');

  let numbers = '';
  if (phase?.status === 'running') {
    numbers = phase.bytes ? `${formatNumber(phase.bytes)} bytes so far` : 'working…';
  } else if (phase) {
    numbers = [
      phase.durationMs != null ? formatDuration(phase.durationMs) : null,
      usage?.inputTokens != null ? `${formatNumber(usage.inputTokens)} in` : null,
      usage?.outputTokens != null ? `${formatNumber(usage.outputTokens)} out` : null,
      usage?.totalNanoAiu != null ? `${formatAiu(usage.totalNanoAiu / NANO_PER_AIU)} AIU` : null,
    ].filter(Boolean).join(' · ');
  }

  const review = reviewSummary(phase);
  const tools = phase ? toolsForPhase(trace, phase.id) : [];

  return h('li', { class: `pass state-${step.state}${step.conditional ? ' conditional' : ''}` },
    h('div', { class: 'pass-head' },
      h('span', { class: 'pass-name' }, step.pass),
      h('span', { class: 'state-label' }, STATE_LABELS[step.state]),
      about ? h('span', {}, about) : null,
      numbers ? h('span', { class: 'pass-meta' }, numbers) : null),
    !phase ? h('p', { class: 'muted verdict' }, `${step.title}: ${step.detail}`) : null,
    review && (review.verdict || review.feedback)
      ? h('p', { class: 'verdict' }, h('strong', {}, 'Verdict: '), review.verdict ?? '—', review.feedback ? ` · ${review.feedback}` : '')
      : null,
    phase?.status === 'failed' && (phase.errorMessage || phase.reason) ? h('p', { class: 'error-text' }, phase.errorMessage ?? phase.reason) : null,
    tools.length
      ? h('ul', { class: 'tool-list', tabindex: '0', 'aria-label': `Tools used in the ${step.pass} pass` }, tools.map((tool) =>
          h('li', {}, h('code', {}, tool.name), ' ', truncate(tool.args, 140), tool.status === 'failed' ? ' (failed)' : tool.status === 'running' ? ' …' : '')))
      : null);
}

function costTable(rows, caption = 'What this run cost') {
  return h('table', { class: 'grid cost' },
    h('caption', { class: 'visually-hidden' }, caption),
    h('thead', {}, h('tr', {},
      ['Pass', 'Model', 'Effort', 'AIU per 1M tokens', 'Premium ×', 'AIU used'].map((label, i) =>
        h('th', { scope: 'col', class: i >= 4 ? 'num-cell' : null }, label)))),
    h('tbody', {}, rows.map((row) =>
      h('tr', {},
        h('th', { scope: 'row' }, row.pass),
        h('td', {}, row.modelName),
        h('td', {}, row.effort ?? '—'),
        h('td', {}, formatPrices(row.prices)),
        h('td', { class: 'num-cell' }, row.premium ?? '—'),
        h('td', { class: 'num-cell' }, formatAiu(row.aiu))))));
}

function totalsLine(trace) {
  const sum = totals(trace);
  const parts = [
    `${formatAiu(sum.reportedAiu ?? sum.aiu)} AIU`,
    sum.premium != null ? plural(sum.premium, 'premium request') : null,
    plural(sum.passes, 'pass', 'passes'),
    sum.requests ? plural(sum.requests, 'model request') : null,
    sum.durationMs != null ? formatDuration(sum.durationMs) : null,
  ].filter(Boolean);
  return h('p', { class: 'totals' }, `Total: ${parts.join(' · ')}`);
}

// Live runs: start one, then follow its events until it's done. The run keeps going on the
// server if this page closes, and reopening the page picks it up again.

async function runLive(demo) {
  if (!canStartLive()) return;
  const confirmed = window.confirm(`Run the ${demo.title} demo live?\n\nThis starts a new HydraFusion session (${demo.tier} tier) and spends AIU from the Copilot plan of the GitHub account this server uses.`);
  if (!confirmed) return;
  state.liveMessage = null;
  try {
    const res = await fetch('/api/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demo: demo.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.activeRun) return followRun(body.activeRun);
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    await followRun(body.run);
  } catch (err) {
    showLiveMessage(`The live run didn’t start: ${err.message}`);
    await loadConfig();
  }
}

async function followRun({ id, title }) {
  if (state.live?.id === id) return;
  state.live = { id, stopping: false };
  startView('live', { title });
  let after = 0;
  let failures = 0;
  while (state.live?.id === id) {
    try {
      const res = await fetch(`/api/live/${encodeURIComponent(id)}?after=${after}`, { cache: 'no-store' });
      if (res.status === 404) throw Object.assign(new Error('The server no longer has this run. It may have restarted.'), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      failures = 0;
      for (const event of body.events) handleEvent('live', event);
      after = body.next;
      if (body.done) break;
    } catch (err) {
      if (err.fatal || ++failures > 5) {
        const trace = state.views.live.trace;
        if (!isFinished(trace)) handleEvent('live', { t: trace.lastT, type: 'run.finished', data: { ok: false, error: err.message } });
        break;
      }
      await sleep(2000 * failures);
    }
  }
  if (state.live?.id === id) state.live = null;
  scheduleRender();
  await Promise.all([loadRecordings(), loadConfig()]);
}

async function stopLive() {
  if (!state.live || state.live.stopping) return;
  state.live.stopping = true;
  scheduleRender();
  try {
    const res = await fetch(`/api/live/${encodeURIComponent(state.live.id)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  } catch (err) {
    if (state.live) state.live.stopping = false;
    showLiveMessage(`Couldn’t stop the run: ${err.message}`);
    scheduleRender();
  }
}

// Replays. They use their own view, so a live run keeps going while one plays.

async function replayRecording(id) {
  const res = await fetch(`/api/recordings/${encodeURIComponent(id)}`);
  if (!res.ok) {
    announce('Couldn’t load that recording.');
    return;
  }
  const recording = await res.json();
  stopReplay();
  startView('replay', { title: recording.title, source: recording.source });
  const events = recording.events ?? [];
  const speed = Math.max(1, (events.at(-1)?.t ?? 0) / REPLAY_TARGET_MS);
  state.replay = { events, index: 0, speed, startedAt: performance.now(), timer: null };

  const tick = () => {
    const replay = state.replay;
    if (!replay) return;
    const elapsed = (performance.now() - replay.startedAt) * replay.speed;
    while (replay.index < replay.events.length && replay.events[replay.index].t <= elapsed) handleEvent('replay', replay.events[replay.index++]);
    if (replay.index < replay.events.length) replay.timer = setTimeout(tick, 100);
    else endReplay();
  };
  tick();
}

function skipReplay() {
  const replay = state.replay;
  if (!replay) return;
  clearTimeout(replay.timer);
  while (replay.index < replay.events.length) handleEvent('replay', replay.events[replay.index++]);
  endReplay();
}

function endReplay() {
  state.replay = null;
  scheduleRender();
}

function stopReplay() {
  if (!state.replay) return;
  clearTimeout(state.replay.timer);
  state.replay = null;
}

function replayReference(demo) {
  const reference = state.recordings.find((r) => r.source === 'reference' && r.demoId === demo.id);
  if (reference) replayRecording(reference.id);
}

function replayLast(demo) {
  const last = lastLive(demo.id);
  if (last) replayRecording(last.id);
}

// Cost tables for the reference runs and the live runs

function groupedCostTable(recordings, { withReplay }) {
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {},
      ['Pattern', 'Step', 'Model', 'AIU per 1M tokens', 'Premium ×', 'AIU used'].map((label, i) =>
        h('th', { scope: 'col', class: i >= 4 ? 'num-cell' : null }, label)))),
    recordings.map((rec) => h('tbody', {},
      rec.rows.length
        ? rec.rows.map((row, i) => h('tr', {},
            i === 0
              ? h('th', { scope: 'rowgroup', rowspan: String(rec.rows.length) },
                  `${patternName(rec.pattern)}, ${rec.tier}`,
                  withReplay ? [h('br'), h('span', { class: 'muted' }, `${rec.title}`), h('br'),
                    h('span', { class: 'muted' }, `${formatAiu(rec.aiu)} AIU, ${formatDuration(rec.durationMs)}`), h('br'),
                    h('button', { type: 'button', class: 'button secondary', onclick: () => replayRecording(rec.id) }, 'Replay', h('span', { class: 'visually-hidden' }, `: ${rec.title}`))] : null)
              : null,
            h('td', {}, row.pass),
            h('td', {}, row.modelName),
            h('td', {}, formatPrices(row.prices)),
            h('td', { class: 'num-cell' }, row.premium ?? '—'),
            h('td', { class: 'num-cell' }, formatAiu(row.aiu))))
        : h('tr', {},
            h('th', { scope: 'row' }, rec.title),
            h('td', { colspan: '5', class: 'error-text' }, rec.error ? `Ended with an error: ${rec.error}` : 'No passes recorded.')))));
}

function renderCostTables() {
  const reference = state.recordings.filter((r) => r.source === 'reference');
  $('#reference-costs').replaceChildren(
    groupedCostTable(reference, { withReplay: false }),
    h('div', { class: 'headlines' }, reference.map((rec) =>
      h('p', { class: 'headline' },
        h('strong', {}, `${formatAiu(rec.aiu)} AIU`),
        h('span', {}, `${patternName(rec.pattern)}${rec.premium != null ? `, ${plural(rec.premium, 'premium request')}` : ''}`)))),
    h('p', { class: 'note' }, 'One run each. The Critique run used older models and missed some problems.'));

  const live = state.recordings.filter((r) => r.source === 'live');
  $('#live-costs').replaceChildren(live.length
    ? groupedCostTable(live, { withReplay: true })
    : h('p', { class: 'muted' }, 'No live runs yet. Run a demo above, or use "npm run demo".'));
}

async function loadRecordings() {
  try {
    const res = await fetch('/api/recordings', { cache: 'no-store' });
    state.recordings = (await res.json()).recordings ?? [];
  } catch {
    state.recordings = [];
  }
  renderCostTables();
  renderCards();
}

buildPatternRows();
buildTokenPrices();
buildCards();
buildChecks();
renderLiveNote();
setInterval(updateStatus, 1000);
$('#run-checks').addEventListener('click', runChecks);
$('#demo-page-url').textContent = new URL('/demo-page/', location.href).href;
loadRecordings().then(loadConfig);
