// Prints a run the way chat shows it: the workflow HydraFusion picked, then each pass as it runs.

import { TOKEN_TYPES, patternName } from './shared/demos.mjs';
import {
  NANO_PER_AIU,
  applyEvent,
  costRows,
  createTrace,
  finalAnswer,
  formatAiu,
  formatDuration,
  formatNumber,
  formatPrices,
  formatScores,
  modelName,
  phaseEffort,
  pipeline,
  reviewSummary,
  selectedWorkflow,
  totals,
} from './shared/trace.mjs';

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const pad = (text, width) => String(text).padEnd(width);
const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max - 3)}...` : text ?? '');

function table(rows, write, indent = '  ') {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  rows.forEach((row, i) => {
    const line = row.map((cell, col) => pad(cell, widths[col])).join('   ').trimEnd();
    write(indent + (i === 0 ? dim(line) : line));
  });
}

function tokensByPrice(trace) {
  const byType = {};
  for (const call of trace.usage) {
    for (const d of call.tokenDetails ?? []) {
      const entry = (byType[d.tokenType] ??= { tokens: 0, nano: 0 });
      entry.tokens += d.tokenCount;
      entry.nano += (d.tokenCount * d.costPerBatch) / d.batchSize;
    }
  }
  return byType;
}

function printSummary(trace, write) {
  write('');
  if (trace.error) write(red(`Run ended with an error: ${trace.error}`));

  const answer = finalAnswer(trace);
  if (answer) {
    write(bold(`Answer${answer.pass ? ` (from ${answer.pass}, ${modelName(trace, answer.model)})` : ''}:`));
    for (const line of answer.content.trim().split('\n')) write(`  ${line}`);
  } else if (trace.meta?.source === 'reference') {
    write(dim('This reference run records models and cost, not the answer.'));
  }

  const rows = costRows(trace);
  if (rows.length) {
    write('');
    write(bold('What it cost'));
    table([
      ['Pass', 'Model', 'Effort', 'AIU per 1M tokens', 'Premium ×', 'AIU used'],
      ...rows.map((r) => [r.pass, r.modelName, r.effort ?? '—', formatPrices(r.prices), r.premium ?? '—', formatAiu(r.aiu)]),
    ], write);
  }

  const byType = tokensByPrice(trace);
  if (Object.keys(byType).length) {
    write('');
    write(bold('Tokens by price'));
    table([
      ['Token type', 'Price vs new input', 'Tokens', 'AIU'],
      ...TOKEN_TYPES.filter((t) => byType[t.type]).map((t) => [t.label, t.relative, formatNumber(byType[t.type].tokens), formatAiu(byType[t.type].nano / NANO_PER_AIU)]),
    ], write);
  }

  const sum = totals(trace);
  const parts = [
    `${formatAiu(sum.reportedAiu ?? sum.aiu)} AIU`,
    sum.premium != null ? `${sum.premium} premium request${sum.premium === 1 ? '' : 's'}` : null,
    `${sum.passes} pass${sum.passes === 1 ? '' : 'es'}`,
    sum.requests ? `${sum.requests} model request${sum.requests === 1 ? '' : 's'}` : null,
    sum.durationMs != null ? formatDuration(sum.durationMs) : null,
  ].filter(Boolean);
  write('');
  write(bold(`Total: ${parts.join(' · ')}`));
}

export function createPrinter(write = (line) => process.stdout.write(`${line}\n`)) {
  const trace = createTrace();

  return function print(event) {
    applyEvent(trace, event);
    const { type, data = {} } = event;
    const phase = data.phaseId ? trace.phases.find((p) => p.id === data.phaseId) : null;

    switch (type) {
      case 'run.started':
        write('');
        write(bold(`${data.title} demo · ${data.tier} tier (${data.model})`) + (data.source === 'reference' ? dim('  reference run') : data.replay ? dim('  replay') : ''));
        write(`Prompt: ${data.prompt}`);
        if (data.pageUrl) write(dim(`Shared page: ${data.pageUrl}`));
        if (data.note) write(dim(data.note));
        break;

      case 'session.fusion_route_started':
        write(dim(`Routing${data.policy ? ` with the ${data.policy} policy` : ''}...`));
        break;

      case 'session.fusion_route_failed':
        write(yellow(`Routing failed (${data.reason}). Carrying on with the fallback model, ${modelName(trace, data.fallbackModel)}.`));
        break;

      case 'session.fusion_resolved': {
        const scores = formatScores(data.scores);
        if (scores) {
          const latency = trace.route?.latencyMs != null ? dim(`  (${formatDuration(trace.route.latencyMs)})`) : '';
          write(`Router scores: ${scores.map((s) => `${s.label} ${s.value.toFixed(2)}`).join(' · ')}${latency}`);
        }
        const expected = trace.meta?.expectedPattern;
        const surprise = expected && expected !== data.pattern ? yellow(`  (this prompt tends to get ${patternName(expected)}, but the router decides)`) : '';
        write(bold(cyan(selectedWorkflow(trace))) + surprise);
        if (data.hint) write(dim(`  ${data.hint}`));
        const plan = pipeline(trace).map((step) => {
          const details = [step.model ? modelName(trace, step.model) : null, step.review ? 'read-only' : null, step.conditional ? 'if needed' : null].filter(Boolean);
          return `${step.pass}${details.length ? ` (${details.join(', ')})` : ''}`;
        });
        write(`  Plan: ${plan.join(' → ')}`);
        break;
      }

      case 'assistant.fusion_phase_started': {
        const effort = phase ? phaseEffort(trace, phase) : null;
        const scope = phase?.scope === 'review' ? dim(' · separate read-only history') : '';
        write(`${cyan('▶')} ${pad(phase?.pass ?? data.phaseKind, 9)} ${modelName(trace, data.model)}${effort ? ` · effort ${effort}` : ''}${scope}`);
        break;
      }

      case 'tool.execution_start':
        write(dim(`    · ${data.toolName} ${truncate(data.args, 110)}`));
        break;

      case 'tool.execution_complete':
        if (!data.success) {
          const tool = trace.tools.find((item) => item.id === data.toolCallId);
          write(red(`    ✖ ${tool?.name ?? 'tool'} failed${data.error ? `: ${truncate(data.error, 160)}` : ''}`));
        }
        break;

      case 'session.fusion_handoff':
        write(dim(`    handing off to ${modelName(trace, data.targetModel)}`));
        break;

      case 'assistant.fusion_phase_completed':
      case 'assistant.fusion_phase_failed': {
        if (!phase) break;
        const ok = phase.status === 'succeeded';
        const usage = phase.usage ?? {};
        const parts = [
          phase.durationMs != null ? formatDuration(phase.durationMs) : null,
          usage.inputTokens != null ? `${formatNumber(usage.inputTokens)} in` : null,
          usage.outputTokens != null ? `${formatNumber(usage.outputTokens)} out` : null,
          usage.totalNanoAiu != null ? `${formatAiu(usage.totalNanoAiu / NANO_PER_AIU)} AIU` : null,
        ].filter(Boolean);
        write(`${ok ? green('✔') : red('✖')} ${pad(phase.pass, 9)} ${parts.join(' · ')}`);
        const review = reviewSummary(phase);
        if (review && (review.verdict || review.feedback)) {
          write(`    ${bold('Verdict:')} ${review.verdict ?? '—'}${review.feedback ? ` · ${truncate(review.feedback, 240)}` : ''}`);
        }
        if (!ok && (phase.errorMessage || phase.reason)) write(red(`    ${phase.errorMessage ?? phase.reason}`));
        break;
      }

      case 'session.error':
        write(red(`Error: ${data.message}`));
        break;

      case 'run.finished':
        printSummary(trace, write);
        break;

      default:
        break;
    }
  };
}
