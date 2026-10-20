// The three demos, and the names HydraFusion uses for its patterns and passes.
// Shared by Node and the browser.

export const DEMOS = [
  {
    id: 'single',
    title: 'Single',
    tier: 'Default',
    model: 'hydrafusion',
    expectedPattern: 'single',
    prompt: 'In one sentence, what does WCAG 1.1.1 require? No tools.',
    sharePage: false,
  },
  {
    id: 'critique',
    title: 'Critique',
    tier: 'Max',
    model: 'hydrafusion-max',
    expectedPattern: 'critique',
    prompt: "Audit this page for WCAG 2.2 AA. Don't change any files. List each problem and the rule it breaks.",
    sharePage: true,
  },
  {
    id: 'cascade',
    title: 'Cascade',
    tier: 'Default',
    model: 'hydrafusion',
    expectedPattern: 'cascade',
    prompt: 'quickly test this page with the browser tools',
    sharePage: true,
  },
];

export const TIERS = {
  Default: 'hydrafusion',
  Max: 'hydrafusion-max',
};

// The steps of each pattern, and the name chat gives each pass while it runs.
export const PATTERNS = {
  single: {
    name: 'Single',
    hint: 'Using Single: one solver will work on your request.',
    steps: [{ kind: 'primary', pass: 'Main', title: 'One model', detail: 'does the whole job' }],
  },
  critique: {
    name: 'Critique',
    hint: 'Using Critique: a solver will draft a result, a critic will review it, and the original solver will revise it if needed.',
    steps: [
      { kind: 'draft', pass: 'First', title: 'Draft', detail: 'solver' },
      { kind: 'critic', pass: 'Critique', title: 'Critic reviews', detail: 'read-only', review: true },
      { kind: 'revision', pass: 'Revision', title: 'Revise', detail: 'same solver, if the critic asks', conditional: true },
    ],
  },
  cascade: {
    name: 'Cascade',
    hint: 'Using Cascade: a solver will work on your request, followed by a review pass and fixes if needed.',
    steps: [
      { kind: 'primary', pass: 'Main', title: 'First answer', detail: 'solver' },
      { kind: 'judge', pass: 'Review', title: 'Judge scores it', detail: 'read-only', review: true },
      { kind: 'repair', pass: 'Fix-up', title: 'Repair', detail: 'stronger model, only if it fails', conditional: true },
    ],
  },
};

export const PASS_LABELS = {
  primary: 'Main',
  draft: 'First',
  critic: 'Critique',
  revision: 'Revision',
  judge: 'Review',
  repair: 'Fix-up',
  follow_up: 'Follow-up',
};

// Price per token compared with new input, for the same model.
export const TOKEN_TYPES = [
  { type: 'cache_read', label: 'Read from cache', relative: '0.05× to 0.1×' },
  { type: 'input', label: 'New input', relative: '1×' },
  { type: 'cache_write', label: 'Written to cache', relative: '1.25×' },
  { type: 'output', label: 'Output', relative: '5×' },
];

export function patternName(pattern) {
  return PATTERNS[pattern]?.name ?? (pattern ? pattern[0].toUpperCase() + pattern.slice(1) : 'Unknown');
}

export function findDemo(id) {
  return DEMOS.find((demo) => demo.id === id);
}
