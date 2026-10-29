// Shared by Node and the browser. Folds recorded run events into one view of a Copilot Fusion turn:
// the route, the pipeline of passes and what each pass cost.
//
// Every event is { t, type, data }, where t is milliseconds since the run started.
// Live runs record the SDK's session events, and the reference runs use the same shape.

import { PASS_LABELS, PATTERNS, patternName } from './demos.mjs';

export const NANO_PER_AIU = 1e9;

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function createTrace() {
  return {
    meta: null,
    status: 'idle',
    route: null,
    plan: null,
    phases: [],
    tools: [],
    messages: [],
    handoffs: [],
    usage: [],
    completion: null,
    error: null,
    durationMs: null,
    lastT: 0,
  };
}

export function buildTrace(events) {
  const trace = createTrace();
  for (const event of events) applyEvent(trace, event);
  return trace;
}

export function applyEvent(trace, { t = 0, type, data = {} }) {
  trace.lastT = Math.max(trace.lastT, t);

  switch (type) {
    case 'run.started':
      trace.meta = data;
      trace.status = 'starting';
      break;

    case 'session.fusion_route_started':
      trace.route = { policy: data.policy, syntheticModel: data.syntheticModel, startedAt: t, latencyMs: null, failed: null };
      trace.status = 'routing';
      break;

    case 'session.fusion_route_failed':
      trace.route = {
        ...(trace.route ?? { startedAt: t }),
        policy: data.policy,
        latencyMs: data.routingLatencyMs ?? null,
        failed: { reason: data.reason, errorMessage: data.errorMessage ?? null, fallbackModel: data.fallbackModel },
      };
      trace.status = 'running';
      break;

    case 'session.fusion_resolved':
      trace.plan = data;
      trace.route = {
        ...(trace.route ?? { startedAt: t, failed: null }),
        policy: data.policy,
        syntheticModel: data.syntheticModel,
        latencyMs: data.routingLatencyMs ?? (trace.route ? t - trace.route.startedAt : null),
      };
      trace.status = 'running';
      break;

    case 'assistant.fusion_phase_started':
      upsertPhase(trace, data.phaseId, {
        kind: data.phaseKind,
        pass: PASS_LABELS[data.phaseKind] ?? data.phaseKind,
        role: data.role,
        model: data.model,
        effort: data.reasoningEffort ?? null,
        scope: data.conversationScope,
        status: 'running',
        startedAt: t,
      });
      trace.status = 'running';
      break;

    case 'assistant.fusion_phase_activity': {
      const phase = findPhase(trace, data.phaseId);
      if (phase && data.totalResponseSizeBytes != null) phase.bytes = data.totalResponseSizeBytes;
      break;
    }

    case 'assistant.fusion_phase_completed':
      upsertPhase(trace, data.phaseId, {
        kind: data.phaseKind,
        pass: PASS_LABELS[data.phaseKind] ?? data.phaseKind,
        role: data.role,
        model: data.model,
        scope: data.conversationScope,
        status: data.status ?? 'succeeded',
        durationMs: data.durationMs ?? null,
        usage: data.usage ?? null,
        verdict: data.verdict ?? null,
        content: data.content ?? '',
        legacyPremium: data.legacyPremium ?? null,
        endedAt: t,
        ...(data.reasoningEffort ? { effort: data.reasoningEffort } : {}),
      });
      break;

    case 'assistant.fusion_phase_failed':
      upsertPhase(trace, data.phaseId, {
        kind: data.phaseKind,
        pass: PASS_LABELS[data.phaseKind] ?? data.phaseKind,
        model: data.model,
        scope: data.conversationScope,
        status: 'failed',
        reason: data.reason,
        errorMessage: data.errorMessage ?? null,
        durationMs: data.durationMs ?? null,
        usage: data.usage ?? null,
        degradedToPhaseId: data.degradedToPhaseId ?? null,
        endedAt: t,
      });
      break;

    case 'session.fusion_handoff':
      trace.handoffs.push({ from: data.sourcePhaseId, to: data.targetPhaseId, model: data.targetModel, t });
      break;

    case 'session.fusion_completed':
      trace.completion = data;
      break;

    case 'assistant.message':
      if (data.content?.trim()) {
        trace.messages.push({ content: data.content, model: data.model, phaseId: data.phaseId ?? currentPhaseId(trace), t });
      }
      break;

    case 'assistant.usage':
      trace.usage.push({ ...data, phaseId: data.phaseId ?? currentPhaseId(trace) });
      break;

    case 'tool.execution_start':
      trace.tools.push({
        id: data.toolCallId,
        name: data.toolName,
        server: data.server ?? null,
        args: data.args ?? '',
        phaseId: data.phaseId ?? currentPhaseId(trace),
        status: 'running',
        t,
      });
      break;

    case 'tool.execution_complete': {
      const tool = trace.tools.find((item) => item.id === data.toolCallId);
      if (tool) {
        tool.status = data.success ? 'ok' : 'failed';
        tool.error = data.error ?? null;
        tool.endedAt = t;
      }
      break;
    }

    case 'session.error':
      trace.error = data.message ?? 'Session error';
      break;

    case 'run.finished':
      trace.status = data.ok ? 'done' : 'error';
      trace.durationMs = data.durationMs !== undefined ? data.durationMs : t;
      if (data.error) trace.error = data.error;
      for (const phase of trace.phases) {
        if (phase.status === 'running') phase.status = data.ok ? 'succeeded' : 'cancelled';
      }
      for (const tool of trace.tools) {
        if (tool.status === 'running') tool.status = data.ok ? 'ok' : 'cancelled';
      }
      break;

    default:
      break;
  }

  return trace;
}

function findPhase(trace, phaseId) {
  return trace.phases.find((phase) => phase.id === phaseId);
}

function upsertPhase(trace, phaseId, fields) {
  let phase = findPhase(trace, phaseId);
  if (!phase) {
    phase = { id: phaseId, status: 'running', bytes: 0, effort: null, startedAt: null };
    trace.phases.push(phase);
  }
  Object.assign(phase, fields);
  return phase;
}

function currentPhaseId(trace) {
  for (let i = trace.phases.length - 1; i >= 0; i--) {
    if (trace.phases[i].status === 'running') return trace.phases[i].id;
  }
  return trace.phases.at(-1)?.id ?? null;
}

export function currentPattern(trace) {
  return trace.plan?.pattern ?? trace.completion?.pattern ?? null;
}

// What chat shows once the route is picked.
export function selectedWorkflow(trace) {
  const pattern = currentPattern(trace);
  return pattern ? `Selected ${patternName(pattern)} workflow` : null;
}

export function isFinished(trace) {
  return trace.status === 'done' || trace.status === 'error';
}

export function modelName(trace, modelId) {
  return trace.meta?.models?.[modelId]?.name ?? modelId ?? '—';
}

function plannedModel(plan, kind) {
  if (!plan) return null;
  switch (kind) {
    case 'critic':
      return plan.critics?.[0]?.model ?? plan.secondaryModel ?? null;
    case 'judge':
      return plan.judgeModel ?? plan.secondaryModel ?? null;
    case 'repair':
      return plan.repairModel ?? plan.secondaryModel ?? null;
    default:
      return plan.primaryModel ?? null;
  }
}

// The route rule names one effort per planned step, for example
// "critique_opus55_medium_luna6_high_opus55_high". Only trust it when the counts line up.
export function effortsFromRule(plan) {
  const steps = plan?.phasePlan;
  if (!plan?.ruleId || !steps?.length) return {};
  const efforts = plan.ruleId.split(/[_-]/).filter((part) => EFFORTS.has(part));
  if (efforts.length !== steps.length) return {};
  return Object.fromEntries(steps.map((step, i) => [step.kind, efforts[i]]));
}

export function phaseEffort(trace, phase) {
  if (phase.effort) return phase.effort;
  const used = [...new Set(trace.usage.filter((u) => u.phaseId === phase.id).map((u) => u.effort).filter(Boolean))];
  if (used.length) return used.join(', ');
  return effortsFromRule(trace.plan)[phase.kind] ?? null;
}

// The pattern's planned steps, merged with what actually ran.
// A conditional step that never ran is "skipped": it only runs when a review asks for it.
export function pipeline(trace) {
  const pattern = currentPattern(trace);
  const template = PATTERNS[pattern]?.steps ?? [];
  const planned = trace.plan?.phasePlan?.length
    ? trace.plan.phasePlan.map((step) => ({ kind: step.kind, conditional: !!step.conditional, review: step.scope === 'review' }))
    : template.map((step) => ({ kind: step.kind, conditional: !!step.conditional, review: !!step.review }));
  const done = isFinished(trace) || !!trace.completion;
  const used = new Set();

  const steps = planned.map((step) => {
    const shape = template.find((s) => s.kind === step.kind) ?? {};
    const phase = trace.phases.find((p) => p.kind === step.kind && !used.has(p.id));
    if (phase) used.add(phase.id);
    return {
      ...step,
      pass: PASS_LABELS[step.kind] ?? step.kind,
      title: shape.title ?? PASS_LABELS[step.kind] ?? step.kind,
      detail: shape.detail ?? '',
      phase: phase ?? null,
      model: phase?.model ?? plannedModel(trace.plan, step.kind),
      state: stepState(phase, step, done),
    };
  });

  for (const phase of trace.phases) {
    if (used.has(phase.id)) continue;
    steps.push({
      kind: phase.kind,
      conditional: false,
      review: phase.scope === 'review',
      pass: phase.pass,
      title: phase.pass,
      detail: 'not in the plan',
      phase,
      model: phase.model,
      state: stepState(phase, {}, done),
      extra: true,
    });
  }
  return steps;
}

function stepState(phase, step, done) {
  if (phase) {
    if (phase.status === 'running') return 'running';
    if (phase.status === 'succeeded') return 'done';
    return 'failed';
  }
  if (done) return step.conditional ? 'skipped' : 'not-run';
  return 'pending';
}

// Critic and judge output is usually JSON, for example {"assessment":"revise","feedback":"..."}.
export function reviewSummary(phase) {
  if (!phase || phase.scope !== 'review') return null;
  let parsed = null;
  try {
    parsed = phase.content ? JSON.parse(phase.content) : null;
  } catch {
    parsed = null;
  }
  const verdict = phase.verdict ?? parsed?.verdict ?? parsed?.assessment ?? parsed?.decision ?? parsed?.result ?? null;
  const feedback = parsed
    ? parsed.feedback ?? parsed.reason ?? parsed.rationale ?? parsed.summary ?? null
    : phase.content || null;
  return { verdict: verdict == null ? null : String(verdict), feedback, details: parsed };
}

export function finalAnswer(trace) {
  const sourceId = trace.completion?.finalSourcePhaseId;
  if (sourceId) {
    const phase = findPhase(trace, sourceId);
    const lastMessage = trace.messages.filter((m) => m.phaseId === sourceId).at(-1);
    const content = phase?.content?.trim() ? phase.content : lastMessage?.content;
    if (content) return { content, model: phase?.model ?? trace.completion.finalSourceModel, phaseId: sourceId, pass: phase?.pass };
  }
  const rootIds = new Set(trace.phases.filter((p) => p.scope !== 'review').map((p) => p.id));
  const last = [...trace.messages].reverse().find((m) => !m.phaseId || rootIds.has(m.phaseId) || !trace.phases.length);
  if (!last) return null;
  const phase = findPhase(trace, last.phaseId);
  return { content: last.content, model: last.model ?? phase?.model, phaseId: last.phaseId, pass: phase?.pass };
}

// Billing detail for one pass, from the SDK's assistant.usage events.
export function phaseBilling(trace, phaseId) {
  const calls = trace.usage.filter((u) => u.phaseId === phaseId);
  const byType = {};
  let nano = 0;
  for (const call of calls) {
    for (const detail of call.tokenDetails ?? []) {
      const entry = (byType[detail.tokenType] ??= { tokens: 0, nano: 0, nanoPerMillion: null });
      const cost = (detail.tokenCount * detail.costPerBatch) / detail.batchSize;
      entry.tokens += detail.tokenCount;
      entry.nano += cost;
      entry.nanoPerMillion = (detail.costPerBatch / detail.batchSize) * 1e6;
      nano += cost;
    }
  }
  const premiumCalls = calls.filter((c) => !c.initiator || c.initiator === 'user');
  return {
    calls: calls.length,
    byType,
    nano,
    premium: premiumCalls.length ? premiumCalls.reduce((sum, c) => sum + (c.cost ?? 0), 0) : null,
  };
}

// One row per pass: model, prices, premium multiplier and AIU used.
export function costRows(trace) {
  return trace.phases.map((phase) => {
    const billing = phaseBilling(trace, phase.id);
    return {
      phaseId: phase.id,
      pass: phase.pass,
      kind: phase.kind,
      model: phase.model,
      modelName: modelName(trace, phase.model),
      effort: phaseEffort(trace, phase),
      prices: trace.meta?.models?.[phase.model]?.prices ?? null,
      premium: billing.premium ?? phase.legacyPremium ?? null,
      aiu: phase.usage?.totalNanoAiu != null ? phase.usage.totalNanoAiu / NANO_PER_AIU : billing.calls ? billing.nano / NANO_PER_AIU : null,
      usage: phase.usage ?? null,
      byType: billing.byType,
      durationMs: phase.durationMs ?? null,
    };
  });
}

export function totals(trace) {
  const c = trace.completion;
  const rows = costRows(trace);
  const sum = (pick) => trace.phases.reduce((acc, phase) => acc + (pick(phase) ?? 0), 0);
  const nano = c?.totalNanoAiu ?? sum((p) => p.usage?.totalNanoAiu);
  const premiums = rows.map((r) => r.premium);
  return {
    aiu: nano / NANO_PER_AIU,
    reportedAiu: trace.meta?.reported?.aiu ?? null,
    inputTokens: c?.inputTokens ?? sum((p) => p.usage?.inputTokens),
    outputTokens: c?.outputTokens ?? sum((p) => p.usage?.outputTokens),
    cachedTokens: c?.cachedTokens ?? sum((p) => p.usage?.cachedTokens),
    cacheWriteTokens: c?.cacheWriteTokens ?? sum((p) => p.usage?.cacheWriteTokens),
    requests: c?.requestCount ?? sum((p) => p.usage?.requestCount),
    passes: c?.phaseCount ?? trace.phases.length,
    durationMs: c?.durationMs ?? trace.durationMs,
    premium: trace.meta?.reported?.premiumRequests
      ?? (premiums.length && premiums.every((p) => p != null) ? premiums.reduce((a, b) => a + b, 0) : null),
  };
}

export function toolsForPhase(trace, phaseId) {
  return trace.tools.filter((tool) => tool.phaseId === phaseId);
}

export function formatAiu(aiu) {
  if (aiu == null || Number.isNaN(aiu)) return '—';
  if (aiu === 0) return '0';
  if (aiu >= 100) return Math.round(aiu).toLocaleString('en-US');
  if (aiu >= 10) return String(Number(aiu.toFixed(1)));
  if (aiu >= 0.01) return String(Number(aiu.toFixed(2)));
  return String(Number(aiu.toPrecision(2)));
}

export function formatNumber(value) {
  return value == null ? '—' : Math.round(value).toLocaleString('en-US');
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatPrices(prices) {
  if (!prices) return '—';
  return `${formatNumber(prices.input)} in, ${formatNumber(prices.output)} out`;
}

export function formatScores(scores) {
  if (!scores) return null;
  return [
    ['reasoning', scores.reasoning],
    ['code', scores.codeGen],
    ['debugging', scores.debugging],
    ['tool use', scores.toolUse],
  ].map(([label, value]) => ({ label, value: Number(value ?? 0) }));
}
