import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadReferenceRecordings, summarize } from '../src/recordings.mjs';
import {
  buildTrace,
  costRows,
  effortsFromRule,
  finalAnswer,
  formatAiu,
  phaseBilling,
  pipeline,
  reviewSummary,
  selectedWorkflow,
  totals,
} from '../src/shared/trace.mjs';

// Legacy pre-launch SDK events remain replayable; this Default-tier run picked Critique.
const FUSION = 'fusion-test';
const critiqueRun = [
  { t: 0, type: 'run.started', data: { demoId: 'single', title: 'Single', tier: 'Default', model: 'hydrafusion', prompt: 'In one sentence, what does WCAG 1.1.1 require? No tools.', expectedPattern: 'single', source: 'live', models: { 'claude-opus-5.5': { name: 'Claude Opus 5.5', prices: { input: 400, output: 2000 } }, 'gpt-6-luna': { name: 'GPT-6 Luna', prices: { input: 10, output: 50 } } } } },
  { t: 100, type: 'session.fusion_route_started', data: { attemptId: `${FUSION}:route`, turnKind: 'user', syntheticModel: 'hydrafusion', policy: 'standard' } },
  { t: 500, type: 'session.fusion_resolved', data: {
    fusionId: FUSION, syntheticModel: 'hydrafusion', policy: 'standard', pattern: 'critique',
    ruleId: 'critique_opus55_medium_luna6_high_opus55_high',
    scores: { reasoning: 0.2391, codeGen: 0.0097, debugging: 0.001, toolUse: 0.0243 },
    hint: 'Using Critique: a solver will draft a result, a critic will review it, and the original solver will revise it if needed.',
    primaryModel: 'claude-opus-5.5', secondaryModel: 'gpt-6-luna',
    phasePlan: [
      { kind: 'draft', role: 'solver', scope: 'root', conditional: false },
      { kind: 'critic', role: 'critic', scope: 'review', conditional: false },
      { kind: 'revision', role: 'solver', scope: 'root', conditional: true },
    ],
  } },
  { t: 510, type: 'assistant.fusion_phase_started', data: { fusionId: FUSION, phaseId: `${FUSION}:phase:0`, phaseKind: 'draft', role: 'solver', conversationScope: 'root', pattern: 'critique', model: 'claude-opus-5.5' } },
  { t: 2900, type: 'assistant.message', data: { content: 'Two sentences. Second one.', model: 'claude-opus-5.5', phaseId: `${FUSION}:phase:0` } },
  { t: 2900, type: 'assistant.usage', data: { model: 'gpt-6-luna', phaseId: `${FUSION}:phase:0`, cost: 1, initiator: 'user', effort: 'medium', tokenDetails: [
    { batchSize: 1000000, costPerBatch: 10000000000, tokenCount: 3, tokenType: 'input' },
    { batchSize: 1000000, costPerBatch: 1000000000, tokenCount: 8595, tokenType: 'cache_read' },
    { batchSize: 1000000, costPerBatch: 12500000000, tokenCount: 4941, tokenType: 'cache_write' },
    { batchSize: 1000000, costPerBatch: 50000000000, tokenCount: 24, tokenType: 'output' },
  ], totalNanoAiu: 71587500 } },
  { t: 2910, type: 'assistant.fusion_phase_completed', data: { fusionId: FUSION, phaseId: `${FUSION}:phase:0`, phaseKind: 'draft', role: 'solver', conversationScope: 'root', model: 'claude-opus-5.5', status: 'succeeded', content: 'Two sentences. Second one.', verdict: null, durationMs: 2400, usage: { requestCount: 1, inputTokens: 22750, outputTokens: 117, cachedTokens: 20000, totalNanoAiu: 1500000000 } } },
  { t: 2920, type: 'assistant.fusion_phase_started', data: { fusionId: FUSION, phaseId: `${FUSION}:critic`, phaseKind: 'critic', role: 'critic', conversationScope: 'review', pattern: 'critique', model: 'gpt-6-luna' } },
  { t: 9000, type: 'assistant.fusion_phase_completed', data: { fusionId: FUSION, phaseId: `${FUSION}:critic`, phaseKind: 'critic', role: 'critic', conversationScope: 'review', model: 'gpt-6-luna', status: 'succeeded', content: '{"assessment":"revise","feedback":"The task asks for one sentence, but the draft has two."}', verdict: null, durationMs: 6313, usage: { requestCount: 1, inputTokens: 1200, outputTokens: 80, cachedTokens: 0, totalNanoAiu: 20000000 } } },
  { t: 9010, type: 'session.fusion_handoff', data: { sourcePhaseId: `${FUSION}:critic`, targetPhaseId: `${FUSION}:revision`, targetModel: 'claude-opus-5.5' } },
  { t: 9020, type: 'assistant.fusion_phase_started', data: { fusionId: FUSION, phaseId: `${FUSION}:revision`, phaseKind: 'revision', role: 'solver', conversationScope: 'root', pattern: 'critique', model: 'claude-opus-5.5' } },
  { t: 9500, type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'browser_snapshot', server: 'browser', args: '{}', phaseId: `${FUSION}:revision` } },
  { t: 9600, type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true, phaseId: `${FUSION}:revision` } },
  { t: 11000, type: 'assistant.message', data: { content: 'One sentence answer.', model: 'claude-opus-5.5', phaseId: `${FUSION}:revision` } },
  { t: 11010, type: 'assistant.fusion_phase_completed', data: { fusionId: FUSION, phaseId: `${FUSION}:revision`, phaseKind: 'revision', role: 'solver', conversationScope: 'root', model: 'claude-opus-5.5', status: 'succeeded', content: 'One sentence answer.', verdict: null, durationMs: 1990, usage: { requestCount: 1, inputTokens: 23000, outputTokens: 60, cachedTokens: 22000, totalNanoAiu: 1000000000 } } },
  { t: 11020, type: 'session.fusion_completed', data: { fusionId: FUSION, pattern: 'critique', phaseCount: 3, requestCount: 3, inputTokens: 46950, outputTokens: 257, cachedTokens: 42000, totalNanoAiu: 2520000000, durationMs: 10500, outcome: 'succeeded', finalSourcePhaseId: `${FUSION}:revision`, finalSourceModel: 'claude-opus-5.5' } },
  { t: 11100, type: 'run.finished', data: { ok: true, durationMs: 11100 } },
];

test('a live trace shows the workflow, passes, review and answer', () => {
  const trace = buildTrace(critiqueRun);
  assert.equal(trace.status, 'done');
  assert.equal(selectedWorkflow(trace), 'Selected Critique workflow');
  assert.deepEqual(pipeline(trace).map((s) => [s.pass, s.state]), [['First', 'done'], ['Critique', 'done'], ['Revision', 'done']]);
  assert.equal(trace.route.policy, 'standard');
  assert.equal(trace.route.latencyMs, 400);

  const review = reviewSummary(trace.phases[1]);
  assert.equal(review.verdict, 'revise');
  assert.match(review.feedback, /one sentence/);

  const answer = finalAnswer(trace);
  assert.equal(answer.content, 'One sentence answer.');
  assert.equal(answer.pass, 'Revision');
  assert.equal(trace.tools[0].phaseId, `${FUSION}:revision`);
});

test('efforts come from the SDK usage, or from the route rule when that is all there is', () => {
  const trace = buildTrace(critiqueRun);
  assert.deepEqual(effortsFromRule(trace.plan), { draft: 'medium', critic: 'high', revision: 'high' });
  const rows = costRows(trace);
  assert.deepEqual(rows.map((r) => r.effort), ['medium', 'high', 'high']);
  assert.deepEqual(effortsFromRule({ ruleId: 'critique_opus55_medium', phasePlan: [{ kind: 'draft' }, { kind: 'critic' }] }), {});
});

test('token billing details add up to the reported nano-AIU', () => {
  const trace = buildTrace(critiqueRun);
  const billing = phaseBilling(trace, `${FUSION}:phase:0`);
  assert.equal(billing.nano, 71587500);
  assert.equal(billing.byType.cache_read.tokens, 8595);
  assert.equal(billing.byType.output.nanoPerMillion / billing.byType.input.nanoPerMillion, 5);
  assert.equal(billing.premium, 1);
});

test('totals prefer the turn total and convert nano-AIU to AIU', () => {
  const sum = totals(buildTrace(critiqueRun));
  assert.equal(sum.aiu, 2.52);
  assert.equal(sum.passes, 3);
  assert.equal(sum.requests, 3);
  assert.equal(sum.durationMs, 10500);
});

test('a routing failure records the fallback model', () => {
  const trace = buildTrace([
    { t: 0, type: 'run.started', data: { prompt: 'x', tier: 'Default', model: 'hydrafusion' } },
    { t: 10, type: 'session.fusion_route_started', data: { policy: 'standard' } },
    { t: 50, type: 'session.fusion_route_failed', data: { reason: 'router_timeout', fallbackModel: 'gpt-6-luna', policy: 'standard', syntheticModel: 'hydrafusion' } },
    { t: 60, type: 'run.finished', data: { ok: true, durationMs: 60 } },
  ]);
  assert.deepEqual(trace.route.failed, { reason: 'router_timeout', errorMessage: null, fallbackModel: 'gpt-6-luna' });
  assert.equal(selectedWorkflow(trace), null);
});

test('the reference runs add up to their reported totals', async () => {
  const reference = await loadReferenceRecordings();
  const byId = Object.fromEntries(reference.map((r) => [r.id, { trace: buildTrace(r.events), summary: summarize(r) }]));

  const critique = byId['reference-critique-max'];
  assert.equal(critique.summary.pattern, 'critique');
  assert.deepEqual(critique.summary.rows.map((r) => [r.modelName, r.premium, formatAiu(r.aiu)]), [['GPT-5.6 Luna', 1, '0.94'], ['GPT-5.6 Terra', 1, '0.28']]);
  assert.deepEqual(pipeline(critique.trace).map((s) => s.state), ['done', 'done', 'skipped']);
  assert.equal(formatAiu(critique.summary.aiu), '1.2');
  assert.equal(critique.summary.premium, 2);

  const cascade = byId['reference-cascade-default'];
  assert.deepEqual(cascade.summary.rows.map((r) => [r.pass, r.modelName, r.premium, formatAiu(r.aiu)]), [
    ['Main', 'GPT-6.1 Sol', 1, '141'],
    ['Review', 'GPT-6 Luna', 1, '0.2'],
    ['Fix-up', 'Claude Opus 5.5', 15, '143'],
  ]);
  assert.equal(reviewSummary(cascade.trace.phases[1]).verdict, 'fail');
  assert.equal(cascade.summary.aiu, 285);
  assert.equal(cascade.summary.premium, 21);

  const single = byId['reference-single-max'];
  assert.deepEqual(single.summary.rows.map((r) => [r.pass, r.modelName, formatAiu(r.aiu)]), [['Main', 'GPT-6 Astra', '74']]);
  assert.equal(single.summary.premium, 1);
  assert.equal(single.trace.durationMs, null);
});

test('formatAiu rounds like the cost tables', () => {
  assert.equal(formatAiu(0.94), '0.94');
  assert.equal(formatAiu(0.2), '0.2');
  assert.equal(formatAiu(1.22), '1.22');
  assert.equal(formatAiu(12.34), '12.3');
  assert.equal(formatAiu(284.2), '284');
  assert.equal(formatAiu(0.0042), '0.0042');
  assert.equal(formatAiu(null), '—');
});
