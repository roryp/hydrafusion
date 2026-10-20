// Runs one demo against HydraFusion through the Copilot SDK and records what chat would show:
// the workflow HydraFusion picked, each pass as it runs, and what each pass cost.

import { CopilotClient } from '@github/copilot-sdk';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, RUNS_DIR, isInside } from './paths.mjs';
import { withoutAppSecrets } from './secrets.mjs';

// HydraFusion is a research preview. VS Code turns these flags on for its chat;
// an SDK host has to opt in itself. The service still decides whether your account can route.
export const HYDRAFUSION_FEATURE_FLAGS = {
  HYDRAFUSION: true,
  HYDRAFUSION_ROLLOUT: true,
  HYDRAFUSION_PLAN_V2: true,
};

export const BROWSER_SERVER = 'browser';

// Playwright MCP provides the browser tools, the same set VS Code has built in.
// browser_run_code_unsafe is left out because it runs code on the server, not in the page;
// browser_evaluate covers the same checks inside the page.
const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_handle_dialog',
  'browser_resize',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_wait_for',
  'browser_console_messages',
  'browser_tabs',
  'browser_select_option',
  'browser_fill_form',
  'browser_close',
];

const READ_ONLY_NOTE = 'This session is read-only: shell commands, file edits and web requests are turned off. '
  + 'Use the browser tools to open and test web pages. Screenshots are saved for you, so don\'t pass a file name.';

const RUN_TIMEOUT_MS = 20 * 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const ACTIVITY_THROTTLE_MS = 1000;
const DEMO_PAGE_TITLE = 'Accessibility Issues Demo - What NOT to Do';

/**
 * How live runs sign in to Copilot. With COPILOT_GITHUB_TOKEN set, they use that token.
 * Otherwise they use the account you're signed in with, unless COPILOT_USE_LOGGED_IN_USER=false.
 */
export function liveAuth(env = process.env) {
  const gitHubToken = env.COPILOT_GITHUB_TOKEN?.trim() || null;
  const useLoggedInUser = !gitHubToken && env.COPILOT_USE_LOGGED_IN_USER !== 'false';
  return { gitHubToken, useLoggedInUser, enabled: !!gitHubToken || useLoggedInUser };
}

export function browserServerConfig(pageUrl) {
  const args = [
    path.join(ROOT, 'src', 'browser-mcp.mjs'),
    '--isolated',
    '--browser', process.env.HF_BROWSER || 'chrome',
    '--viewport-size', '1280x800',
    '--output-dir', path.join(RUNS_DIR, 'playwright-mcp'),
  ];
  if (!process.env.HF_HEADED) args.push('--headless');
  if (process.env.BROWSER_NO_SANDBOX) args.push('--no-sandbox');
  if (pageUrl) args.push('--allowed-origins', new URL(pageUrl).origin);
  return { type: 'local', command: process.execPath, args, tools: BROWSER_TOOLS, timeout: 120_000 };
}

// Your own MCP servers stay out of demo sessions, so every run sees the same tools.
async function userMcpServerNames(client) {
  try {
    const { servers } = await client.rpc.mcp.config.list();
    return Object.keys(servers ?? {}).filter((name) => name !== BROWSER_SERVER);
  } catch {
    try {
      const file = path.join(os.homedir(), '.copilot', 'mcp-config.json');
      return Object.keys(JSON.parse(await readFile(file, 'utf8')).mcpServers ?? {}).filter((name) => name !== BROWSER_SERVER);
    } catch {
      return [];
    }
  }
}

async function modelCatalog(client) {
  try {
    const models = await client.listModels();
    return Object.fromEntries(models.map((model) => {
      const p = model.billing?.tokenPrices;
      const prices = p ? { input: p.inputPrice, output: p.outputPrice, cacheRead: p.cacheReadPrice, cacheWrite: p.cacheWritePrice } : null;
      return [model.id, { name: model.name, prices }];
    }));
  } catch {
    return {};
  }
}

function reject(feedback) {
  return { kind: 'reject', feedback };
}

// The demos only read. Reviews can't change your files, and here nothing can.
function readOnlyPermissions(request) {
  switch (request.kind) {
    case 'mcp':
      return request.serverName === BROWSER_SERVER
        ? { kind: 'approve-once' }
        : reject('Only the browser tools are turned on for this demo.');
    case 'read': {
      const target = path.resolve(ROOT, request.path ?? '');
      return isInside(target, ROOT) || isInside(target, os.tmpdir())
        ? { kind: 'approve-once' }
        : reject('Reads are limited to this project.');
    }
    default:
      return reject('This demo is read-only. Use the browser tools and file reads; shell commands, file edits and web requests are turned off.');
  }
}

function shareBrowserPage(pageUrl) {
  return {
    type: 'extension_context',
    extensionId: 'hydrafusion-demos',
    title: `Browser page: ${DEMO_PAGE_TITLE}`,
    capturedAt: new Date().toISOString(),
    payload: {
      kind: 'browser-page',
      url: pageUrl,
      title: DEMO_PAGE_TITLE,
      note: 'The user shared this browser page with chat. "This page" means this page. Open it with the browser tools.',
    },
  };
}

function summarizeArgs(args) {
  if (args == null) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

// Keeps the parts of each SDK event that the dashboard and CLI need, and drops the rest.
function recordable(event, lastActivity) {
  const { type } = event;
  const data = event.data ?? {};
  switch (type) {
    case 'session.fusion_route_started':
    case 'session.fusion_route_failed':
    case 'session.fusion_resolved':
    case 'session.fusion_completed':
    case 'assistant.fusion_phase_started':
    case 'assistant.fusion_phase_completed':
    case 'assistant.fusion_phase_failed':
      return data;
    case 'assistant.fusion_phase_activity': {
      if (data.activity !== 'model_output') return undefined;
      const now = Date.now();
      if (now - (lastActivity.get(data.phaseId) ?? 0) < ACTIVITY_THROTTLE_MS) return undefined;
      lastActivity.set(data.phaseId, now);
      return { phaseId: data.phaseId, phaseKind: data.phaseKind, activity: data.activity, totalResponseSizeBytes: data.totalResponseSizeBytes };
    }
    case 'session.fusion_handoff':
      // The handoff message repeats the task, the draft and the review, so only the route is kept.
      return { sourcePhaseId: data.sourcePhaseId, targetPhaseId: data.targetPhaseId, targetModel: data.targetModel };
    case 'assistant.message':
      return { content: data.content ?? '', model: data.model ?? null, phaseId: data.fusion?.phaseId ?? null, toolCalls: data.toolRequests?.length ?? 0 };
    case 'assistant.usage':
      return {
        model: data.model,
        phaseId: data.fusion?.phaseId ?? null,
        cost: data.cost ?? null,
        initiator: data.initiator ?? null,
        effort: data.reasoningEffort ?? null,
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        cacheReadTokens: data.cacheReadTokens ?? 0,
        cacheWriteTokens: data.cacheWriteTokens ?? 0,
        tokenDetails: data.copilotUsage?.tokenDetails ?? [],
        totalNanoAiu: data.copilotUsage?.totalNanoAiu ?? null,
        durationMs: data.duration ?? null,
      };
    case 'tool.execution_start':
      return {
        toolCallId: data.toolCallId,
        toolName: data.mcpToolName ?? data.toolName,
        server: data.mcpServerName ?? null,
        args: summarizeArgs(data.arguments),
        phaseId: data.fusion?.phaseId ?? null,
      };
    case 'tool.execution_complete':
      return { toolCallId: data.toolCallId, success: !!data.success, error: data.error?.message ?? null, phaseId: data.fusion?.phaseId ?? null };
    case 'session.error':
      return { message: data.message, errorType: data.errorType };
    default:
      return undefined;
  }
}

function usedModels(events, catalog) {
  const ids = new Set();
  for (const { type, data } of events) {
    if (type === 'assistant.fusion_phase_started' || type === 'assistant.usage') ids.add(data.model);
    if (type === 'session.fusion_resolved') {
      for (const id of [data.primaryModel, data.secondaryModel, data.judgeModel, data.repairModel, data.fallbackModel]) if (id) ids.add(id);
    }
    if (type === 'session.fusion_route_failed') ids.add(data.fallbackModel);
  }
  return Object.fromEntries([...ids].filter((id) => catalog[id]).map((id) => [id, catalog[id]]));
}

// Resolves to true if the promise settles in time, false if it doesn't.
function settles(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(true); },
    );
  });
}

function runId(demo, startedAt) {
  return `${startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}-${demo.id}`;
}

/**
 * Runs one demo in a new session, the way you'd open a new chat, set the tier and send the prompt.
 * Returns a recording that the CLI and the dashboard can replay.
 */
export async function runLiveDemo(demo, { pageUrl, onEvent = () => {}, signal, auth = liveAuth() } = {}) {
  const startedAt = new Date();
  const events = [];
  const emit = (type, data) => {
    const event = { t: Date.now() - startedAt.getTime(), type, data };
    events.push(event);
    onEvent(event);
  };

  const client = new CopilotClient({
    logLevel: 'error',
    env: withoutAppSecrets(process.env),
    ...(auth.gitHubToken ? { gitHubToken: auth.gitHubToken, useLoggedInUser: false } : { useLoggedInUser: auth.useLoggedInUser }),
  });
  let session;
  let catalog = {};
  let ok = false;
  let error = null;

  try {
    if (!auth.enabled) throw new Error('Live runs need a GitHub token with Copilot access. Set COPILOT_GITHUB_TOKEN.');
    if (signal?.aborted) throw new Error('Cancelled before the run started.');
    await client.start();
    catalog = await modelCatalog(client);
    emit('run.started', {
      demoId: demo.id,
      title: demo.title,
      tier: demo.tier,
      model: demo.model,
      prompt: demo.prompt,
      expectedPattern: demo.expectedPattern,
      pageUrl: demo.sharePage ? pageUrl : null,
      source: 'live',
      startedAt: startedAt.toISOString(),
      models: catalog,
    });

    session = await client.createSession({
      model: demo.model,
      featureFlags: HYDRAFUSION_FEATURE_FLAGS,
      enableExperimentalMode: true,
      clientName: 'hydrafusion-demos',
      workingDirectory: ROOT,
      systemMessage: { mode: 'append', content: READ_ONLY_NOTE },
      disabledMcpServers: await userMcpServerNames(client),
      mcpServers: { [BROWSER_SERVER]: browserServerConfig(pageUrl) },
      onPermissionRequest: readOnlyPermissions,
    });

    const lastActivity = new Map();
    session.on((event) => {
      const data = recordable(event, lastActivity);
      if (data !== undefined) emit(event.type, data);
    });

    const onAbort = () => session?.abort().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await session.sendAndWait(
        {
          prompt: demo.prompt,
          attachments: demo.sharePage && pageUrl ? [shareBrowserPage(pageUrl)] : undefined,
        },
        RUN_TIMEOUT_MS,
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw new Error('Stopped.');
    ok = true;
  } catch (err) {
    error = err?.message ?? String(err);
  } finally {
    emit('run.finished', { ok, error, durationMs: Date.now() - startedAt.getTime() });
    // Shutting down can hang on a stuck browser, so it gets a time limit and the run is still saved.
    if (session) await settles(session.disconnect(), CLEANUP_TIMEOUT_MS);
    if (!(await settles(client.stop(), CLEANUP_TIMEOUT_MS))) await settles(client.forceStop(), CLEANUP_TIMEOUT_MS);
  }

  const startedEvent = events.find((e) => e.type === 'run.started');
  if (startedEvent) startedEvent.data = { ...startedEvent.data, models: usedModels(events, catalog) };

  return {
    id: runId(demo, startedAt),
    title: `${demo.title} demo, ${demo.tier} tier (live, ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    source: 'live',
    demoId: demo.id,
    savedAt: new Date().toISOString(),
    events,
  };
}
